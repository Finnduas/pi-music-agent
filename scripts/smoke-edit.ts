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
import { analyzeScore, changesOutsideGaps, findGaps } from "../src/music/abc.js";

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
/* ---- guard: nothing outside the gap may change ---------------------------- */
const DRIFTED = FILLED.replace("e c A | D3", "e c A | D F A"); // gap filled, but another bar was rewritten
check("guard sees the drift", changesOutsideGaps(WITH_GAP, DRIFTED).length === 1);
check("guard accepts a clean gap fill", changesOutsideGaps(WITH_GAP, FILLED).length === 0);
check(
  "guard sees a changed header",
  changesOutsideGaps(WITH_GAP, FILLED.replace("K:G", "K:D")).some((p) => p.includes("header K")),
);
check(
  "guard sees a changed bar count",
  changesOutsideGaps(WITH_GAP, FILLED.replace("G3 |]", "G3 | G3 |]")).some((p) => p.includes("bar count")),
);

// A) first attempt drifts -> retried with feedback -> clean result
{
  const replies = [DRIFTED, FILLED];
  const prompts: string[] = [];
  const r = await composePiece(
    { request: "fill in the gap", title: "Guard A", existingAbc: WITH_GAP, edit: true },
    {
      config: cfg,
      noPersist: true,
      composerFn: {
        async complete(_s: string, user: string) {
          prompts.push(user);
          return "```abc\n" + (replies.shift() ?? FILLED) + "\n```";
        },
      },
      criticFn: { async complete() { return JSON.stringify({ score: 8, strengths: [], issues: [], suggestions: [], summary: "ok" }); } },
      composerLabel: "mock",
      criticLabel: "mock",
    },
  );
  check("A: drift detected and logged", r.log.some((l) => l.includes("changed music outside the gap")));
  check("A: composer was asked again with the problem listed", prompts.length === 2 && prompts[1].includes("OUTSIDE the gap"));
  check("A: final result is clean", changesOutsideGaps(WITH_GAP, r.abc).length === 0 && findGaps(r.abc).length === 0);
  check("A: no guard warnings left", r.validationWarnings.every((w) => !w.includes("outside the gap")));
}

// B) critic asks for more, the revision rewrites other bars -> revision rejected
{
  let composerCalls = 0;
  const r = await composePiece(
    { request: "fill in the gap", title: "Guard B", existingAbc: WITH_GAP, edit: true },
    {
      config: cfg,
      noPersist: true,
      composerFn: {
        async complete() {
          composerCalls++;
          return "```abc\n" + (composerCalls === 1 ? FILLED : DRIFTED) + "\n```";
        },
      },
      criticFn: { async complete() { return JSON.stringify({ score: 4, strengths: [], issues: ["weak cadence"], suggestions: ["rewrite the ending"], summary: "meh" }); } },
      composerLabel: "mock",
      criticLabel: "mock",
    },
  );
  check("B: drifting revision rejected", r.log.some((l) => l.includes("revision rejected")));
  check("B: previous (clean) version kept", changesOutsideGaps(WITH_GAP, r.abc).length === 0 && !r.abc.includes("D F A"));
}

// C) a revision scores WORSE than the first version -> the better first version is returned
{
  const SECOND = FILLED.replace("e d c | B2 A", "e d c | B2 B"); // still a clean gap fill, just different
  let composerCalls = 0;
  let criticCalls = 0;
  const r = await composePiece(
    { request: "fill in the gap", title: "Best of", existingAbc: WITH_GAP, edit: true },
    {
      config: cfg,
      noPersist: true,
      composerFn: {
        async complete() {
          composerCalls++;
          return "```abc\n" + (composerCalls === 1 ? FILLED : SECOND) + "\n```";
        },
      },
      criticFn: {
        async complete() {
          criticCalls++;
          const score = criticCalls === 1 ? 6 : 3;
          return JSON.stringify({ score, strengths: [], issues: ["x"], suggestions: ["y"], summary: "s" });
        },
      },
      composerLabel: "mock",
      criticLabel: "mock",
    },
  );
  check("C: the loop revised once", composerCalls === 2 && criticCalls === 2);
  check("C: the better (first) version is kept", r.abc.includes("B2 A") && !r.abc.includes("B2 B"));
  check("C: its score is reported, not the lower one", r.critic?.score === 6);
  check("C: the log says so", r.log.some((l) => l.includes("Keeping the best version")));
}

// D) reference pieces (--refs) really reach the composer prompt
{
  let prompt = "";
  await composePiece(
    { request: "a minuet in this style", title: "Refs", references: [WITH_GAP, "X:9\nT:Other Ref\nK:C\nC D E F|]"] },
    {
      config: cfg,
      noPersist: true,
      composerFn: {
        async complete(_s: string, user: string) {
          prompt = prompt || user;
          return "```abc\n" + FILLED + "\n```";
        },
      },
      criticFn: { async complete() { return JSON.stringify({ score: 9, strengths: [], issues: [], suggestions: [], summary: "ok" }); } },
      composerLabel: "mock",
      criticLabel: "mock",
    },
  );
  check("D: composer prompt contains the reference block", prompt.includes("Reference material"));
  check("D: ...with every reference piece", prompt.includes("Minuet with a Gap") && prompt.includes("Other Ref"));
}

await fs.rm(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nAll edit smoke checks passed.");
