
globalThis.WebSocket = WebSocket;
// index.js — Morpheus main server
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";
import { enqueueJob, dequeueJob, completeJob, requeueJob, recoverStuckJobs, isDuplicateMessage } from "./queue.js";
import { runAgent } from "./agent/loop.js";
import { startCronJobs } from "./cron.js";

// ── Startup env validation (Bug #16 fixed: fail loudly, not silently) ──
const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "WA_TOKEN",
  "WA_PHONE_ID",
  "APP_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_USERNAME",
  "VERCEL_TOKEN",
  "OWNER_PHONE",
  "MORPHEUS_SECRET",
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("❌ Missing required environment variables:");
  missing.forEach(k => console.error(`   - ${k}`));
  process.exit(1);
}

const app      = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── Raw body for HMAC verification ──────────────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ── WhatsApp 4096 char split (Bug #13 fixed) ────────────────────────
export async function sendWhatsApp(to, text) {
  const MAX = 4096;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      chunks.push(remaining);
      break;
    }
    // Split at last newline before the limit
    const splitAt = remaining.lastIndexOf("\n", MAX) || MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${process.env.WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: chunk },
        }),
      }
    );
    if (!res.ok) {
      console.error("[WA] Send failed:", await res.text());
    }
    if (chunks.length > 1) await sleep(300); // small delay between chunks
  }
}

// ── HMAC verification middleware ─────────────────────────────────────
function verifyHMAC(req, res, next) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return res.status(401).send("No signature");
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  if (sig !== expected) return res.status(403).send("Invalid signature");
  next();
}

// ── Webhook verification ─────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode  = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.MORPHEUS_SECRET) {
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming WhatsApp message ────────────────────────────────────────
app.post("/webhook", verifyHMAC, async (req, res) => {
  res.sendStatus(200); // Ack immediately

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;

    const phone = message.from;
    const msgId = message.id;

    // Bug #15 fixed: deduplicate by message ID
    if (await isDuplicateMessage(msgId)) {
      console.log(`[Webhook] Duplicate message ignored: ${msgId}`);
      return;
    }

    const text = (message.text?.body || "").trim();
    await routeMessage(phone, text, message);

  } catch (err) {
    console.error("[Webhook] Error:", err.message);
  }
});

// ── Message router ───────────────────────────────────────────────────
async function routeMessage(phone, text, rawMessage) {
  const lower = text.toLowerCase();

  // Status
  if (lower === "status" || lower === "s") {
    return handleStatus(phone);
  }

  // Help
  if (lower === "help" || lower === "h" || lower === "?") {
    return sendWhatsApp(phone, [
      "🧠 *Morpheus — your AI build partner*",
      "",
      "*Commands:*",
      "• *build [idea]* — start a build",
      "• *status* — check active jobs",
      "• *restart* — restart stuck jobs",
      "• *help* — this message",
      "",
      "Or just describe what you want built!",
    ].join("\n"));
  }

  // Restart
  if (lower === "restart") {
    return sendWhatsApp(phone, "♻️ Use Railway dashboard to restart the server.");
  }

  // Build command — Bug #7 fixed: voice-aware classifier
  // Matches: "build X", "create X", "make X", "hey build me X", natural language
  const isBuildIntent = (
    /^build\b/i.test(text) ||
    /^create\b/i.test(text) ||
    /^make\b/i.test(text) ||
    /\bbuild\s+(me\s+)?(a|an|the)?\s+\w/i.test(text) ||
    text.split(" ").length > 4  // Any multi-word message treated as a build prompt
  );

  if (isBuildIntent) {
    const prompt = text.replace(/^(build|create|make)\s+(me\s+)?/i, "").trim() || text;
    const jobId  = await enqueueJob({ phone, prompt });
    return sendWhatsApp(phone, `✅ Queued! Job ID: ${jobId}\n\nI'll get started shortly.`);
  }

  // Fallback — treat as prompt
  const jobId = await enqueueJob({ phone, prompt: text });
  await sendWhatsApp(phone, `✅ Got it! Building: "${text.slice(0, 60)}"\n\nJob ID: ${jobId}`);
}

async function handleStatus(phone) {
  const { data } = await supabase
    .from("projects")
    .select("status, prompt, iterations, created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!data?.length) {
    return sendWhatsApp(phone, "No builds yet! Send me a prompt to get started.");
  }

  const lines = data.map(p => {
    const icon  = p.status === "complete" ? "✅" : p.status === "running" ? "⚙️" : "❌";
    const label = p.prompt?.slice(0, 50) || "(no prompt)";
    return `${icon} ${label} (${p.iterations || 0} steps)`;
  });

  await sendWhatsApp(phone, `*Your recent builds:*\n\n${lines.join("\n")}`);
}

// ── Worker loop — polls Redis queue every 3s ─────────────────────────
let activeJob = null;

async function workerLoop() {
  while (true) {
    try {
      const job = await dequeueJob();
      if (job) {
        activeJob = job;
        console.log(`[Worker] Starting job: ${job.id} — "${job.prompt?.slice(0, 60)}"`);

        // Look up venture if provided
        let venture = null;
        if (job.ventureId) {
          const { data } = await supabase.from("ventures").select("*").eq("id", job.ventureId).single();
          venture = data;
        }

        try {
          await runAgent({ job, venture });
        } catch (err) {
          console.error(`[Worker] Job ${job.id} errored:`, err.message);
        } finally {
          await completeJob(job.id);
          activeJob = null;
        }
      }
    } catch (err) {
      console.error("[Worker] Loop error:", err.message);
    }
    await sleep(3000);
  }
}

// ── Graceful SIGTERM — requeue active job (Bug #12 fixed) ────────────
process.on("SIGTERM", async () => {
  console.log("[Shutdown] SIGTERM received — requeuing active job...");
  if (activeJob) {
    try {
      await requeueJob(activeJob);
      console.log(`[Shutdown] Job ${activeJob.id} requeued`);
    } catch (err) {
      console.error("[Shutdown] Requeue failed:", err.message);
    }
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Shutdown] SIGINT — exiting cleanly");
  process.exit(0);
});

// ── Startup ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Morpheus v2.0 running on port ${PORT}`);

  // Recover any stuck jobs from before last restart
  const recovered = await recoverStuckJobs();
  if (recovered > 0) console.log(`[Startup] Recovered ${recovered} expired jobs`);

  // Start scheduled tasks
  startCronJobs();

  // Start worker
  workerLoop().catch(err => console.error("[Worker] Fatal:", err.message));
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
