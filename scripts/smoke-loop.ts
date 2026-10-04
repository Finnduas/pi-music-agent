// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for the full agent loop (no network / no API key).
 * Run: npx tsx scripts/smoke-loop.ts
 *
 * Fakes the LLM roles to exercise: invalid->valid retry, low score -> revise ->
 * high score, render, and store.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { composePiece } from "../src/loop/orchestrator.js";

const VALID_ABC = `X:1
T:Offline Etude
M:4/4
L:1/8
K:C
C2 D2 E2 F2 | G4 G4 | A2 G2 F2 E2 | C8 |]`;

const REVISED_ABC = `X:1
T:Offline Etude (revised)
M:4/4
L:1/8
K:C
C2 E2 G2 c2 | G8 | A2 F2 E2 D2 | C8 |]`;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-smoke-"));
  const cfg = loadConfig();
  cfg.storage = { dir }; // no sqlite
  cfg.validation.backend = "local";
  cfg.render.formats = ["html"]; // avoid needing an SVG engine
  cfg.loop = { maxValidationRetries: 5, maxIterations: 3, scoreThreshold: 8 };

  let composerCalls = 0;
  let criticCalls = 0;

  const composerFn = {
    async complete(_system: string, user: string) {
      composerCalls++;
      // First call: deliberately invalid (missing X: header) to test retry.
      if (composerCalls === 1) {
        return "```abc\nT:Broken\nM:4/4\nL:1/8\nK:C\nC D E F |\n```";
      }
      // Retry after validation errors -> valid.
      if (composerCalls === 2) {
        return "```abc\n" + VALID_ABC + "\n```";
      }
      // Revision after low critic score -> valid revised.
      return "```abc\n" + REVISED_ABC + "\n```";
    },
  };

  const criticFn = {
    async complete(_system: string, _user: string) {
      criticCalls++;
      if (criticCalls === 1) {
        return JSON.stringify({
          score: 5,
          strengths: ["clear meter"],
          issues: ["static harmony"],
          suggestions: ["add a tonic-dominant cadence"],
          summary: "Serviceable but plain.",
        });
      }
      return JSON.stringify({
        score: 9,
        strengths: ["strong cadence", "balanced phrases"],
        issues: [],
        suggestions: [],
        summary: "Publication-ready.",
      });
    },
  };

  const result = await composePiece(
    { request: "a short C-major etude", style: "classical", title: "Offline Etude" },
    {
      config: cfg,
      composerFn,
      criticFn,
      composerLabel: "mock/composer",
      criticLabel: "mock/critic",
      onProgress: (l) => console.log("  " + l),
    },
  );

  const checks: [string, boolean][] = [
    ["composer called 3 times (invalid, retry, revise)", composerCalls === 3],
    ["critic called 2 times (low then high)", criticCalls === 2],
    ["loop ran 2 iterations", result.iterations === 2],
    ["final critic score is 9", result.critic?.score === 9],
    ["final ABC is the revised one", result.abc.includes("(revised)")],
    ["at least one file rendered", result.files.length >= 1],
    ["index.jsonl written", await exists(path.join(dir, "index.jsonl"))],
    ["record json written", await exists(path.join(dir, `${result.id}.json`))],
  ];

  console.log("\n--- checks ---");
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  if (!ok) process.exit(1);
  console.log("\nAll loop smoke checks passed.");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
