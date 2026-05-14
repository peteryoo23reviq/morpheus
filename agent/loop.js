// agent/loop.js — main agent loop
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { executeTool } from "./tools.js";
import { reviewBuild } from "./reviewer.js";
import { deployProject } from "../deployer.js";
import { sendWhatsApp } from "../index.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
import ws from "ws";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } });

const MAX_ITER  = 80;
const BUILD_DIR = process.env.BUILD_DIR || "/tmp/morpheus-builds";

// ── Tool definitions passed to Claude ───────────────────────────────
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command in the project directory.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd:     { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Relative file path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "patch_file",
    description: "Find and replace ALL occurrences of a string in a file.",
    input_schema: {
      type: "object",
      properties: {
        path:   { type: "string" },
        oldStr: { type: "string", description: "Exact string to find (all occurrences replaced)" },
        newStr: { type: "string", description: "Replacement string" },
      },
      required: ["path", "oldStr", "newStr"],
    },
  },
  {
    name: "list_files",
    description: "List all files in a directory.",
    input_schema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Directory to list (default: project root)" },
      },
      required: [],
    },
  },
  {
    name: "remember",
    description: "Save something important to long-term memory for this venture.",
    input_schema: {
      type: "object",
      properties: {
        type:      { type: "string", enum: ["technical", "preference", "decision", "pattern", "user"] },
        title:     { type: "string" },
        content:   { type: "string" },
        importance:{ type: "number", description: "1-10" },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "recall",
    description: "Retrieve relevant memories for this venture.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "commit_progress",
    description: "Commit current build files to GitHub so progress is saved mid-build.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
      },
      required: ["message"],
    },
  },
  {
    name: "report_progress",
    description: "Send a WhatsApp progress update to the user.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];

// ── Main run function ────────────────────────────────────────────────
export async function runAgent({ job, venture }) {
  const { id: jobId, phone, prompt } = job;

  // Create isolated build directory for this job
  const projectDir = path.join(BUILD_DIR, jobId);
  mkdirSync(projectDir, { recursive: true });

  // Create project record in Supabase
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .insert({
      job_id:     jobId,
      venture_id: venture?.id || null,
      phone,
      prompt,
      status:     "running",
      iterations: 0,
    })
    .select()
    .single();

  if (projErr) {
    console.error("[Loop] Failed to create project:", projErr.message);
    await sendWhatsApp(phone, "❌ Failed to start project. Please try again.");
    return;
  }

  await sendWhatsApp(phone, `🧠 *Morpheus is thinking...*\n\n"${prompt}"\n\nI'll update you as I build. This may take a while.`);

  const messages   = [];
  let iteration    = 0;
  let lastReport   = 0;
  let completed    = false;

  const systemPrompt = `You are Morpheus, an autonomous AI build partner. You build complete, production-ready web projects based on user prompts.

You have access to bash, file tools, memory, and deployment tools. Use them freely.

Working directory: ${projectDir}

Rules:
- Build complete, working projects — not scaffolds
- Commit progress every ~10 tool calls using commit_progress
- Report progress to the user every ~15 iterations
- When you're done, call report_progress with a summary including the live URL
- Write clean, modern code. No placeholders. No TODOs.
- If you hit an error, fix it — don't report it as a failure

Venture context: ${venture ? JSON.stringify({ name: venture.name, description: venture.description }) : "none"}`;

  messages.push({ role: "user", content: prompt });

  while (iteration < MAX_ITER) {
    iteration++;

    // Wall-clock timeout check (Bug #6)
    if (Date.now() > job.timeoutAt) {
      await supabase.from("projects")
        .update({ status: "timeout", iterations: iteration })
        .eq("id", project.id);
      await sendWhatsApp(phone, `⏱️ Job timed out after 6 hours. Progress has been committed to GitHub.`);
      break;
    }

    let response;
    try {
      response = await anthropic.messages.create({
        model:      "claude-opus-4-5",
        max_tokens: 8096,
        system:     systemPrompt,
        tools:      TOOLS,
        messages,
      });
    } catch (err) {
      console.error(`[Loop] Anthropic error at iteration ${iteration}:`, err.message);
      await sendWhatsApp(phone, `⚠️ API error at step ${iteration} — retrying...`);
      await sleep(5000);
      continue;
    }

    // Build assistant message
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type === "text" && block.text?.trim()) {
        console.log(`[Loop] iter ${iteration}:`, block.text.slice(0, 120));
      }

      if (block.type === "tool_use") {
        const ctx = { projectDir, project, venture, phone, iteration };
        const result = await executeTool(block.name, block.input, ctx);

        // Handle report_progress specially — actually send the message
        if (block.name === "report_progress") {
          const ventureLabel = venture ? `[${venture.display || venture.name}] ` : "";
          await sendWhatsApp(phone, `${ventureLabel}${block.input.message}`);
        }

        // Auto-progress update every 15 iterations
        if (iteration - lastReport >= 15 && block.name !== "report_progress") {
          lastReport = iteration;
          await sendWhatsApp(phone, `⚡ Still building... (step ${iteration}, running: ${block.name})`);
        }

        // Check for completion signal
        if (block.name === "report_progress" && block.input.message?.includes("complete")) {
          completed = true;
        }

        toolResults.push({
          type:        "tool_result",
          tool_use_id: block.id,
          content:     JSON.stringify(result),
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }

    // Update iteration count
    await supabase.from("projects")
      .update({ iterations: iteration })
      .eq("id", project.id);

    // Done if Claude stopped using tools
    if (response.stop_reason === "end_turn" && !assistantContent.some(b => b.type === "tool_use")) {
      if (!completed) {
        await supabase.from("projects")
          .update({ status: "complete", iterations: iteration, completed_at: new Date().toISOString() })
          .eq("id", project.id);
        await sendWhatsApp(phone, `✅ Build complete after ${iteration} steps.`);
        await extractAndSaveMemories(project, venture, messages);
      }
      break;
    }
  }

  if (iteration >= MAX_ITER && !completed) {
    await supabase.from("projects")
      .update({ status: "failed", iterations: iteration })
      .eq("id", project.id);
    await sendWhatsApp(phone, `⚠️ Reached max steps (${MAX_ITER}). Type *status* to review.`);
  }

  // Clean up build dir
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
}

// ── Extract and save memories after build ───────────────────────────
async function extractAndSaveMemories(project, venture, messages) {
  if (!venture) return;
  try {
    // Ask Claude to extract key learnings in a lightweight call
    const summary = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Extract 2-3 key technical decisions or patterns from this build session as JSON array:
${JSON.stringify(messages.slice(-10))}

Format: [{ "type": "technical|pattern|decision", "title": "short title", "content": "what was learned", "importance": 1-10 }]
JSON only, no other text.`,
      }],
    });

    const raw = summary.content[0]?.text?.replace(/```json|```/g, "").trim();
    const memories = JSON.parse(raw || "[]");
    for (const mem of memories) {
      await supabase.from("memories").insert({
        venture_id:        venture.id,
        source_project_id: project.id,
        ...mem,
      });
    }
  } catch (err) {
    console.error("[Loop] Memory extraction failed:", err.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
