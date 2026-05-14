// queue.js — single shared Redis instance
import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY      = "morpheus:jobs:pending";
const PROCESSING_KEY = "morpheus:jobs:processing";
const DEDUP_KEY      = "morpheus:msg:dedup";
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function makeJobId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${Date.now()}_${rand}`;
}

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

export async function dequeueJob() {
  const raw = await redis.rpop(QUEUE_KEY);
  if (!raw) return null;
  const job = typeof raw === "string" ? JSON.parse(raw) : raw;
  await redis.lpush(PROCESSING_KEY, JSON.stringify(job));
  return job;
}

export async function completeJob(jobId) {
  const all = await redis.lrange(PROCESSING_KEY, 0, -1);
  for (const raw of all) {
    const item = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (item.id === jobId) {
      await redis.lrem(PROCESSING_KEY, 1, raw);
      return true;
    }
  }
  return false;
}

export async function requeueJob(job) {
  await completeJob(job.id);
  await redis.lpush(QUEUE_KEY, JSON.stringify({ ...job, requeuedAt: Date.now() }));
}

export async function recoverStuckJobs() {
  const all = await redis.lrange(PROCESSING_KEY, 0, -1);
  let recovered = 0;
  for (const raw of all) {
    const job = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Date.now() > job.timeoutAt) {
      await redis.lrem(PROCESSING_KEY, 1, raw);
      recovered++;
    }
  }
  return recovered;
}

export async function isDuplicateMessage(messageId) {
  const key = `${DEDUP_KEY}:${messageId}`;
  const result = await redis.set(key, "1", { nx: true, ex: 300 });
  return result === null;
}