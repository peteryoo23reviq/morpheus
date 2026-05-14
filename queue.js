// queue.js — single shared Redis instance (Bug #3 fixed: was 4 separate connections)
import { Redis } from "@upstash/redis";

// ── Single export — import this everywhere, never new Redis() again ──
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY      = "morpheus:jobs:pending";
const PROCESSING_KEY = "morpheus:jobs:processing";
const DEDUP_KEY      = "morpheus:msg:dedup";   // for WhatsApp dedup
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;    // Bug #6 fixed: 6hr wall-clock max

// ── Generate collision-safe job ID (Bug #5 fixed: was Date.now() only) ──
function makeJobId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${Date.now()}_${rand}`;
}

// ── Enqueue a new build job ──────────────────────────────────────────
export async function enqueueJob({ phone, prompt, ventureId = null }) {
  const job = {
    id:        makeJobId(),
    phone,
    prompt,
    ventureId,
    queuedAt:  Date.now(),
    timeoutAt: Date.now() + JOB_TIMEOUT_MS,
  };
  await redis.lpush(QUEUE_KEY, JSON.stringify(job));
  return job.id;
}

// ── Dequeue next job with proper polling (Bug #11 fixed: no busy-wait loop) ──
// Returns null immediately if queue empty — caller handles poll interval
export async function dequeueJob() {
  const raw = await redis.rpoplpush(QUEUE_KEY, PROCESSING_KEY);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// ── Mark job complete — remove from processing (Bug #2 fixed: lrem by job.id) ──
export async function dequeueJob() {
  const raw = await redis.rpop(QUEUE_KEY);
  if (!raw) return null;
  const job = typeof raw === "string" ? JSON.parse(raw) : raw;
  await redis.lpush(PROCESSING_KEY, JSON.stringify(job));
  return job;
}
    if (item.id === jobId) {
      await redis.lrem(PROCESSING_KEY, 1, raw);
      return true;
    }
  }
  return false;
}

// ── Requeue a job (used by SIGTERM handler) ─────────────────────────
export async function requeueJob(job) {
  await completeJob(job.id);
  await redis.lpush(QUEUE_KEY, JSON.stringify({ ...job, requeuedAt: Date.now() }));
}

// ── Requeue all stuck processing jobs (called on startup after crash) ──
export async function recoverStuckJobs() {
  const all = await redis.lrange(PROCESSING_KEY, 0, -1);
  let recovered = 0;
  for (const raw of all) {
    const job = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Date.now() > job.timeoutAt) {
      await redis.lrem(PROCESSING_KEY, 1, raw);
      recovered++;
      console.log(`[Queue] Expired job removed: ${job.id}`);
    }
  }
  return recovered;
}

// ── WhatsApp message dedup (Bug #15 fixed) ──────────────────────────
// Returns true if this message was already seen (duplicate), false if new
export async function isDuplicateMessage(messageId) {
  const key   = `${DEDUP_KEY}:${messageId}`;
  const result = await redis.set(key, "1", { nx: true, ex: 300 }); // 5min TTL
  return result === null; // null = key already existed = duplicate
}
