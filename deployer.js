// deployer.js — GitHub push, Vercel deploy, Netlify deploy
import { Octokit } from "octokit";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ── Ensure GitHub repo exists ────────────────────────────────────────
async function ensureRepo(owner, repo) {
  try {
    await octokit.rest.repos.get({ owner, repo });
  } catch (e) {
    if (e.status === 404) {
      await octokit.rest.repos.createForAuthenticatedUser({
        name:    repo,
        private: false,
        auto_init: true,
        description: `Built by Morpheus — autonomous AI builder`,
      });
      // Wait for repo to initialize
      await sleep(2000);
    } else throw e;
  }
}

// ── Recursively collect all files from a directory ──────────────────
function collectFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, base));
    } else {
      const relativePath = path.relative(base, fullPath).replace(/\\/g, "/");
      const content = readFileSync(fullPath);
      files.push({ path: relativePath, content });
    }
  }
  return files;
}

// ── Push all project files to GitHub ────────────────────────────────
export async function pushToGitHub({ projectDir, repoName, commitMessage = "Morpheus build" }) {
  const owner = process.env.GITHUB_USERNAME;
  const repo  = repoName || `morpheus-${Date.now()}`;

  await ensureRepo(owner, repo);

  // Get current HEAD SHA
  let treeSha, parentSha;
  try {
    const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: "heads/main" });
    parentSha = ref.object.sha;
    const { data: commit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
    treeSha = commit.tree.sha;
  } catch {
    parentSha = null;
    treeSha   = null;
  }

  const files = collectFiles(projectDir);

  // Create blobs for all files
  const treeItems = await Promise.all(
    files.map(async ({ path: filePath, content }) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner, repo,
        content:  content.toString("base64"),
        encoding: "base64",
      });
      return { path: filePath, mode: "100644", type: "blob", sha: blob.sha };
    })
  );

  // Create tree
  const { data: newTree } = await octokit.rest.git.createTree({
    owner, repo,
    tree:      treeItems,
    base_tree: treeSha || undefined,
  });

  // Create commit
  const commitData = {
    owner, repo,
    message: commitMessage,
    tree:    newTree.sha,
  };
  if (parentSha) commitData.parents = [parentSha];

  const { data: newCommit } = await octokit.rest.git.createCommit(commitData);

  // Update HEAD
  try {
    await octokit.rest.git.updateRef({
      owner, repo, ref: "heads/main", sha: newCommit.sha,
    });
  } catch {
    await octokit.rest.git.createRef({
      owner, repo, ref: "refs/heads/main", sha: newCommit.sha,
    });
  }

  return { repoUrl: `https://github.com/${owner}/${repo}`, owner, repo };
}

// ── Commit a single snapshot mid-build (Bug #14 fix) ─────────────────
// Keeps work safe even if Railway redeploys during a long build
export async function commitFileDuringBuild({ projectDir, message, jobId }) {
  const owner = process.env.GITHUB_USERNAME;
  const repo  = `morpheus-wip-${jobId}`;
  try {
    await pushToGitHub({ projectDir, repoName: repo, commitMessage: message || "WIP: mid-build snapshot" });
  } catch (err) {
    // Non-fatal — log and continue
    console.warn("[Deployer] Mid-build commit failed:", err.message);
  }
}

// ── Deploy to Vercel ─────────────────────────────────────────────────
export async function deployToVercel({ owner, repo }) {
  const res = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name:       repo,
      gitSource: { type: "github", org: owner, repo, ref: "main" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel deploy failed: ${err}`);
  }

  const data = await res.json();
  return await waitForVercelDeployment(data.id);
}

async function waitForVercelDeployment(deploymentId, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
    });
    const data = await res.json();
    if (data.readyState === "READY") return `https://${data.url}`;
    if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
      throw new Error(`Vercel deployment failed: ${data.readyState}`);
    }
    await sleep(15000);
  }
  throw new Error("Vercel deployment timed out");
}

// ── Deploy to Netlify ─────────────────────────────────────────────────
export async function deployToNetlify({ projectDir, siteName }) {
  // Create or get site
  const siteRes = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${process.env.NETLIFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: siteName }),
  });

  const site = await siteRes.json();
  const siteId = site.id;

  // Deploy files
  const files = collectFiles(projectDir);
  const fileMap = {};
  for (const { path: filePath, content } of files) {
    fileMap[`/${filePath}`] = content.toString("utf8");
  }

  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${process.env.NETLIFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: fileMap }),
  });

  const deploy = await deployRes.json();
  return `https://${deploy.ssl_url || site.default_domain}`;
}

// ── Full deploy orchestration ────────────────────────────────────────
export async function deployProject({ projectDir, repoName }) {
  const { repoUrl, owner, repo } = await pushToGitHub({ projectDir, repoName });

  let liveUrl;
  try {
    liveUrl = await deployToVercel({ owner, repo });
  } catch (err) {
    console.warn("[Deployer] Vercel failed, trying Netlify:", err.message);
    liveUrl = await deployToNetlify({ projectDir, siteName: repo });
  }

  return { repoUrl, liveUrl };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
