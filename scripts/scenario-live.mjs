// SPDX-License-Identifier: GPL-3.0-or-later
// Live end-to-end scenarios (npm run scenario). Calls the real LLM, so it needs an API key
// (OPENROUTER_API_KEY or Ollama) and, by default, n8n running (falls back to local if not).
//
//   Scenario 1  FILL THE GAP : examples/input/minuet-with-gap.abc  -> edit "fill in the gap"
//   Scenario 2  COMPOSITION  : compose "a short minuet in G major" -> validate
//
// Usage: npm run build && npm run scenario [-- --only gap|compose]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeScore, changesOutsideGaps, findGaps } from "../dist/music/abc.js";
import { createValidator } from "../dist/validate/validator.js";
import { loadConfig } from "../dist/config.js";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "all";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const cli = path.join(root, "dist", "cli.js");

let failed = false;
const check = (name, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !extra ? "" : "  -> " + extra}`);
  if (!pass) failed = true;
};

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args, "--json", "--dry-run"], { cwd: root, encoding: "utf8", maxBuffer: 50e6 });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || "").trim().slice(0, 500) };
  try { return JSON.parse(r.stdout); } catch { return { error: "non-JSON output: " + r.stdout.slice(0, 300) }; }
}
const validator = createValidator(loadConfig().validation);

/* ---------------- Scenario 1: fill in the gap ---------------- */
if (only === "all" || only === "gap") {
  console.log("\n== Scenario 1: fill in the gap ==");
  const file = path.join(root, "examples", "input", "minuet-with-gap.abc");
  const original = fs.readFileSync(file, "utf8");

  check("input has a gap at bars 5-6", JSON.stringify(findGaps(original)) === JSON.stringify(["bars 5-6"]), JSON.stringify(findGaps(original)));

  const res = run(["edit", file, "fill in the gap in bars 5-6"]);
  check("edit ran without error", !res.error, res.error);
  if (!res.error) {
    const edited = res.abc;
    const v = await validator.validate({ notation: edited, title: "gap test" });
    check("result is valid ABC", v.valid, v.errors.join("; "));
    check("gap is gone", findGaps(edited).length === 0, JSON.stringify(findGaps(edited)));
    const outside = changesOutsideGaps(original, edited);
    check("nothing outside bars 5-6 changed", outside.length === 0, outside.join("; "));
    const a = analyzeScore(edited);
    check("meter and key preserved (3/4, G)", a.meter.replace(/\s/g, "") === "3/4" && /^G/.test(a.key), `${a.meter} ${a.key}`);
    check("bar count preserved", a.bars === analyzeScore(original).bars, `${a.bars} vs ${analyzeScore(original).bars}`);
  }
}

/* ---------------- Scenario 2: composition ---------------- */
if (only === "all" || only === "compose") {
  console.log("\n== Scenario 2: composition ==");
  const res = run(["compose", "a short, graceful minuet in G major for solo piano", "--style", "classical", "--title", "Scenario Minuet"]);
  check("compose ran without error", !res.error, res.error);
  if (!res.error) {
    const abc = res.abc;
    const v = await validator.validate({ notation: abc, title: "compose test" });
    check("result is valid ABC", v.valid, v.errors.join("; "));
    const a = analyzeScore(abc);
    check("has a body of at least 8 bars", a.bars >= 8, `bars=${a.bars}`);
    check("key is G major", /^G(?!m|min)/.test(a.key) && !a.minor, a.key);
    check("meter is 3/4", a.meter.replace(/\s/g, "") === "3/4", a.meter);
    check("ends on the tonic", a.endsOnTonic !== false, String(a.endsOnTonic));
    check("no leftover gaps", findGaps(abc).length === 0, JSON.stringify(findGaps(abc)));
  }
}

console.log(failed ? "\nSome scenario checks FAILED." : "\nAll scenario checks passed.");
process.exit(failed ? 1 : 0);
