// agent/tools.js — tool implementations for the agent loop
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { commitFileDuringBuild } from "../deployer.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Safe env for bash — strips all secrets (Bug #1 fixed: was passing full env) ──
function safeEnv() {
  const ALLOWED = new Set([
    "PATH", "HOME", "USER", "SHELL", "LANG", "PWD",
    "NODE_ENV", "NODE_PATH", "npm_execpath",
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED.has(k)) env[k] = v;
  }
  return env;
}

// ── Tool: bash ───────────────────────────────────────────────────────
export function bash({ command, cwd, timeout = 30000 }) {
  const workDir = cwd || process.env.BUILD_DIR || "/tmp/morpheus-build";
  mkdirSync(workDir, { recursive: true });

  try {
    const output = execSync(command, {
      cwd:      workDir,
      env:      safeEnv(),          // Bug #1: secrets stripped
      timeout,
      maxBuffer: 1024 * 1024 * 5,  // 5MB
      encoding: "utf8",
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return {
      success: false,
      output:  err.stdout?.trim() || "",
      error:   err.stderr?.trim() || err.message,
    };
  }
}

// ── Tool: write_file ─────────────────────────────────────────────────
export function writeFile({ path: filePath, content, projectDir }) {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectDir, filePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return { success: true, path: fullPath };
}

// ── Tool: read_file ──────────────────────────────────────────────────
export function readFile({ path: filePath, projectDir }) {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectDir, filePath);
  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${fullPath}` };
  }
  return { success: true, content: readFileSync(fullPath, "utf8") };
}

// ── Tool: patch_file — replaceAll fix (Bug #8: was replace(), only hit first match) ──
export function patchFile({ path: filePath, oldStr, newStr, projectDir }) {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectDir, filePath);

  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${fullPath}` };
  }

  const original = readFileSync(fullPath, "utf8");

  if (!original.includes(oldStr)) {
    return { success: false, error: "oldStr not found in file — nothing changed." };
  }

  // Bug #8 fixed: replaceAll replaces every occurrence, not just the first
  const patched = original.replaceAll(oldStr, newStr);
  writeFileSync(fullPath, patched, "utf8");

  const count = (original.split(oldStr).length - 1);
  return { success: true, replacements: count };
}

// ── Tool: list_files ─────────────────────────────────────────────────
export function listFiles({ dir, projectDir }) {
  const fullDir = path.isAbsolute(dir) ? dir : path.join(projectDir, dir);
  const { output } = bash({ command: `find . -type f | sort`, cwd: fullDir });
  return { success: true, files: output };
}

// ── Tool: remember ───────────────────────────────────────────────────
export async function remember({ type, title, content, ventureId, projectId, importance = 7 }) {
  const { error } = await supabase.from("memories").insert({
    venture_id:        ventureId || null,
    type,
    title,
    content,
    source_project_id: projectId || null,
    importance,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── Tool: recall — knowledge retrieval (Bug #4 fixed: was .cs.{}, invalid PostgREST) ──
export async function recall({ query, ventureId, limit = 5 }) {
  let q = supabase
    .from("memories")
    .select("type, title, content, importance")
    .order("importance", { ascending: false })
    .limit(limit);

  if (ventureId) {
    // Bug #4 fixed: use .eq() or .contains() not .cs.{}
    q = q.eq("venture_id", ventureId);
  }

  const { data, error } = await q;
  if (error) return { success: false, error: error.message };
  return { success: true, memories: data || [] };
}

// ── Tool: commit_progress — persist files to GitHub mid-build (Bug #14 fixed) ──
// Railway wipes /tmp on redeploy — commit periodically so work isn't lost
export async function commitProgress({ projectDir, message, jobId }) {
  try {
    await commitFileDuringBuild({ projectDir, message, jobId });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Tool: report_progress — send WhatsApp update mid-build ──────────
export async function reportProgress({ message, phone, iteration }) {
  // Actual send happens in loop.js via the sendWhatsApp util
  return { success: true, message, phone, iteration };
}

// ── Tool dispatcher ──────────────────────────────────────────────────
export async function executeTool(name, input, ctx) {
  const { projectDir, project, venture, phone, iteration } = ctx;

  switch (name) {
    case "bash":
      return bash({ ...input, cwd: input.cwd || projectDir });

    case "write_file":
      return writeFile({ ...input, projectDir });

    case "read_file":
      return readFile({ ...input, projectDir });

    case "patch_file":
      return patchFile({ ...input, projectDir });

    case "list_files":
      return listFiles({ ...input, projectDir });

    case "remember":
      return remember({ ...input, ventureId: venture?.id, projectId: project?.id });

    case "recall":
      return recall({ ...input, ventureId: venture?.id });

    case "commit_progress":
      return commitProgress({ ...input, projectDir, jobId: project?.job_id });

    case "report_progress":
      return reportProgress({ ...input, phone, iteration });

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}
