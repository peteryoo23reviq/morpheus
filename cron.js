// cron.js — scheduled tasks (Bug #17 fixed: .catch() on every handler)
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { sendWhatsApp } from "./index.js";
import { redis, recoverStuckJobs } from "./queue.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export function startCronJobs() {
  // ── Morning briefing — 8am in owner's timezone ──────────────────
  cron.schedule(
    "0 8 * * *",
    () => morningBriefing().catch(err => console.error("[Cron] Morning briefing failed:", err.message)),
    { timezone: process.env.TIMEZONE || "America/New_York" }
  );

  // ── Stuck job recovery — every 30 min ───────────────────────────
  cron.schedule(
    "*/30 * * * *",
    () => recoverStuckJobs().catch(err => console.error("[Cron] Job recovery failed:", err.message))
  );

  // ── Nightly project summary — 11pm ──────────────────────────────
  cron.schedule(
    "0 23 * * *",
    () => nightlySummary().catch(err => console.error("[Cron] Nightly summary failed:", err.message)),
    { timezone: process.env.TIMEZONE || "America/New_York" }
  );

  console.log("[Cron] All scheduled tasks started");
}

async function morningBriefing() {
  const phone = process.env.OWNER_PHONE;
  if (!phone) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: projects } = await supabase
    .from("projects")
    .select("status, prompt, completed_at, iterations")
    .gte("created_at", yesterday)
    .order("created_at", { ascending: false });

  if (!projects?.length) {
    await sendWhatsApp(phone, "☀️ *Morning briefing*\n\nNo builds ran overnight. Send me a prompt to get started!");
    return;
  }

  const done   = projects.filter(p => p.status === "complete");
  const failed = projects.filter(p => p.status === "failed");

  let msg = `☀️ *Morning briefing*\n\n`;
  msg += `*Last 24 hours:* ${done.length} built, ${failed.length} failed\n\n`;

  for (const p of done.slice(0, 3)) {
    msg += `✅ ${p.prompt?.slice(0, 60)}...\n`;
  }
  for (const p of failed.slice(0, 2)) {
    msg += `❌ ${p.prompt?.slice(0, 60)}...\n`;
  }

  msg += `\nType *status* for details.`;
  await sendWhatsApp(phone, msg);
}

async function nightlySummary() {
  const phone = process.env.OWNER_PHONE;
  if (!phone) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("projects")
    .select("*", { count: "exact", head: true })
    .gte("created_at", today.toISOString())
    .eq("status", "complete");

  if (count > 0) {
    await sendWhatsApp(phone, `🌙 *Nightly summary*\n\n${count} project(s) completed today. Morpheus is standing by.`);
  }
}
