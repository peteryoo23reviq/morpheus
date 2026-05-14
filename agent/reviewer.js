// agent/reviewer.js — honest build reviewer, no score inflation
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { bash } from "./tools.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function reviewBuild(projectDir, classification, research, iteration, originalPrompt) {
  // Gather file list and sample key files
  const { output: fileList } = bash({ command: "find . -type f | grep -v node_modules | grep -v .git | sort", cwd: projectDir });

  let sampleCode = "";
  const files = fileList.split("\n").slice(0, 6);
  for (const f of files) {
    const fullPath = path.join(projectDir, f.replace(/^\.\//, ""));
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf8").slice(0, 800);
        sampleCode += `\n\n// ${f}\n${content}`;
      } catch {}
    }
  }

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are a brutally honest senior developer reviewing a build. No flattery.

Original prompt: "${originalPrompt}"
Classification: ${classification}
Build iterations used: ${iteration}

Files built:
${fileList}

Sample code:
${sampleCode}

Score this build 1-10 where:
- 1-4: Broken, incomplete, or fundamentally wrong
- 5-6: Works but generic or missing key features
- 7-8: Good, most requirements met, minor gaps
- 9-10: Exceptional — industry-standard quality, you'd pay for this

Best-in-class benchmarks for comparison: Shopify (ecommerce), Stripe (payments), Linear (dashboards), Notion (editors), Vercel (landing pages)

Respond ONLY as JSON:
{
  "score": <number>,
  "rationale": "<one sentence honest reason for the score>",
  "what_works": ["<specific thing 1>", "<specific thing 2>"],
  "weaknesses": ["<specific weakness 1>", "<specific weakness 2>", "<specific weakness 3>"],
  "vs_benchmark": "<compared to [best-in-class], this is missing X>",
  "prompt_grade": "<A/B/C/D — how clear was the original prompt>"
}`,
    }],
  });

  try {
    const raw = response.content[0]?.text?.replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    return {
      score: 5,
      rationale: "Review parsing failed — build may still be functional",
      what_works: [],
      weaknesses: ["Could not parse review output"],
      vs_benchmark: "Unknown",
      prompt_grade: "C",
    };
  }
}
