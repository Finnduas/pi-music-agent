// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for "edit / fill the gap": gap detection + the edit pass of
 * the loop (fake LLMs, no network). Run: npx tsx scripts/smoke-edit.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { composePiece } from "../src/loop/orchestrator.js";
import { analyzeScore, findGaps } from "../src/music/abc.js";

let failed = false;
function check(name: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) failed = true;
}

const WITH_GAP = await fs.readFile(new URL("../examples/input/minuet-with-gap.abc", import.meta.url), "utf8");
const FILLED = WITH_GAP.replace('"^GAP" z3 | z3 |', "e d c | B2 A |");

check("detects rest-only/annotated bars 5-6", JSON.stringify(findGaps(WITH_GAP)) === JSON.stringify(["bars 5-6"]));
check("no gaps in filled score", findGaps(FILLED).length === 0);
check("analysis carries gaps", analyzeScore(WITH_GAP).gaps.length === 1);
check(
  "per-voice gaps",
  JSON.stringify(findGaps("X:1\nM:4/4\nK:C\nV:RH\nC4|D4|\nV:LH\nz4|C4|z4|]")) === JSON.stringify(["LH bar 1", "LH bar 3"]),
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-edit-"));
const cfg = loadConfig();
cfg.storage = { dir };
cfg.validation.backend = "local";
cfg.render.formats = ["html"];
cfg.loop = { maxValidationRetries: 3, maxIterations: 2, scoreThreshold: 7 };

let composerUser = "";
const result = await composePiece(
  { request: "fill in the gap", title: "Minuet with a Gap", existingAbc: WITH_GAP, edit: true },
  {
    config: cfg,
    composerFn: {
      async complete(_s: string, user: string) {
        composerUser = user;
        return "```abc\n" + FILLED + "\n```";
      },
    },
    criticFn: {
      async complete() {
        return JSON.stringify({ score: 8, strengths: ["fits"], issues: [], suggestions: [], summary: "Gap filled." });
      },
    },
    composerLabel: "mock/composer",
    criticLabel: "mock/critic",
    onProgress: (l) => console.log("  " + l),
  },
);

check("composer got the edit prompt with the instruction", composerUser.includes("Instruction: fill in the gap"));
check("composer saw the detected gap", composerUser.includes("bars 5-6"));
check("result has no remaining gaps", findGaps(result.abc).length === 0);
check("log reports the remaining-gap check", result.log.some((l) => l.includes("Remaining candidate gaps: none")));
check("rendered a file", result.files.length >= 1);
await fs.rm(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nAll edit smoke checks passed.");
