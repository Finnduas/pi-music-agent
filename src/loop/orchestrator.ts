// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** The agent loop: compose -> validate (retries) -> critique -> iterate -> render -> store. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { projectRoot } from "../config.js";
import { clientForRole, describeRole } from "../llm/roles.js";
import { extractAbc, extractJson } from "../llm/parse.js";
import { analyzeScore, changesOutsideGaps, formatAnalysis } from "../music/abc.js";
import { createValidator } from "../validate/validator.js";
import { renderAbc } from "../render/renderer.js";
import { Store } from "../store/store.js";
import type { ComposeRequest, ComposeResult, CriticReport } from "../types.js";

export async function loadPrompt(name: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(path.join(projectRoot, "prompts", `${name}.md`), "utf8");
  } catch {
    return fallback;
  }
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function factsBlock(abc: string): string {
  return `Score facts (deterministic, approximate):\n${formatAnalysis(analyzeScore(abc))}\n`;
}

async function askComposer(
  composer: RoleCompleter,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  if (composer.completeWithTools) return composer.completeWithTools(system, user, signal);
  return composer.complete(system, user, signal);
}

export function salvageScore(text: string): number {
  const m = text.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0;
}

export function coerceReport(raw: any, fallbackText: string): CriticReport {
  const num = Number(raw?.score);
  return {
    score: Number.isFinite(num) ? Math.max(0, Math.min(10, num)) : 0,
    strengths: Array.isArray(raw?.strengths) ? raw.strengths.map(String) : [],
    issues: Array.isArray(raw?.issues) ? raw.issues.map(String) : [],
    suggestions: Array.isArray(raw?.suggestions) ? raw.suggestions.map(String) : [],
    summary: typeof raw?.summary === "string" ? raw.summary : "",
    raw: fallbackText,
  };
}

export interface RoleCompleter {
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
  /** Optional native tool-calling path (used for the composer when available). */
  completeWithTools?(system: string, user: string, signal?: AbortSignal): Promise<string>;
}

export interface ComposeDeps {
  config: AppConfig;
  /** Optional callback for progress lines. */
  onProgress?: (line: string) => void;
  /** If true, render and store are skipped (dry run). */
  noPersist?: boolean;
  /** Override the role clients (used for tests/offline runs). */
  composerFn?: RoleCompleter;
  criticFn?: RoleCompleter;
  composerLabel?: string;
  criticLabel?: string;
}

export async function composePiece(
  req: ComposeRequest,
  deps: ComposeDeps,
): Promise<ComposeResult> {
  const { config: cfg } = deps;
  const started = Date.now();
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    deps.onProgress?.(line);
  };

  const validator = createValidator(cfg.validation);
  const composer = deps.composerFn ?? clientForRole(cfg, "composer");
  const critic = deps.criticFn ?? clientForRole(cfg, "critic");
  const composerLabel = deps.composerLabel ?? describeRole(cfg, "composer");
  const criticLabel = deps.criticLabel ?? describeRole(cfg, "critic");
  const composerSystem = await loadPrompt(
    "composer",
    "You are a classical composer. Return only a complete, valid ABC score in a ```abc fenced block.",
  );
  const criticSystem = await loadPrompt(
    "critic",
    'You are a music critic. Return only JSON: {"score":number,"strengths":[],"issues":[],"suggestions":[],"summary":""}.',
  );

  const title = req.title ?? deriveTitle(req.request);
  const styleLine = req.style ? `Style/period: ${req.style}\n` : "";

  say(`Composer: ${composerLabel}`);
  say(`Critic:   ${criticLabel}`);
  say(`Validation backend: ${cfg.validation.backend}`);

  /* ---------------------------- initial ABC ----------------------------- */
  let abc = req.existingAbc?.trim() ?? "";
  const isEdit = Boolean(abc && req.edit);
  const originalAbc = abc;
  // "Fill the gap" edits are held to a strict rule: nothing outside the gap may change.
  const gapFill =
    isEdit && analyzeScore(abc).gaps.length > 0 && /\b(gap|fill|missing|blank|empty)/i.test(req.request);
  const gapGuardWarnings: string[] = [];
  if (isEdit) {
    const before = analyzeScore(abc).gaps;
    say(`Editing supplied score. Candidate gaps: ${before.length ? before.join("; ") : "none detected"}`);
    const user =
      `Edit the existing score below according to the instruction.\n\n` +
      `Instruction: ${req.request}\n${styleLine}` +
      `RULES: keep the header (X:, M:, L:, K:, V:) and every bar the instruction does not ` +
      `mention EXACTLY as written. If asked to fill a gap, write music only for the gap ` +
      `bars (rest-only bars or bars marked "GAP"), matching the surrounding key, meter, ` +
      `voice, rhythm and phrase shape, and make the passage lead naturally into the next bar. ` +
      `Remove any "GAP" markers you fill. Return the COMPLETE score.\n\n` +
      `${factsBlock(abc)}\nCurrent ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
    abc = extractAbc(await askComposer(composer, composerSystem, user));
    const after = analyzeScore(abc).gaps;
    say(`Edit applied. Remaining candidate gaps: ${after.length ? after.join("; ") : "none"}`);

    if (gapFill) {
      for (let attempt = 1; ; attempt++) {
        const bad = changesOutsideGaps(originalAbc, abc);
        if (!bad.length) {
          say("Guard: every bar outside the gap is unchanged.");
          break;
        }
        say(`Guard: the edit changed music outside the gap (${bad.length}): ${bad.slice(0, 3).join("; ")}`);
        if (attempt >= cfg.loop.maxValidationRetries) {
          gapGuardWarnings.push(`Edit changed music outside the gap: ${bad.slice(0, 5).join("; ")}`);
          say("Guard: giving up; the result still differs outside the gap (see warnings).");
          break;
        }
        const retry =
          `Your edit changed music OUTSIDE the gap, which is not allowed. Problems:\n` +
          `${bad.slice(0, 8).map((p) => `- ${p}`).join("\n")}\n\n` +
          `Redo it: copy every bar outside the gap EXACTLY as in the original (headers, voices, ` +
          `notes, accidentals) and write new music only for the gap bars.\n\n` +
          `Instruction: ${req.request}\n${factsBlock(originalAbc)}\n` +
          `Original ABC:\n\`\`\`abc\n${originalAbc}\n\`\`\``;
        abc = extractAbc(await askComposer(composer, composerSystem, retry));
      }
    }
  } else if (abc) {
    say("Starting from supplied ABC (skipping initial composition).");
  } else {
    say("Composing initial sketch...");
    const refBlock = req.references?.length
      ? `\nReference material (emulate the style/technique, do not copy):\n${req.references
          .map((r, i) => `\`\`\`abc\n${r.slice(0, 4000)}\n\`\`\``)
          .join("\n")}`
      : "";
    const user =
      `Compose a piece.\n\nRequest: ${req.request}\n${styleLine}` +
      `Title suggestion: ${title}\n${refBlock}\n` +
      `Return the full ABC score in a single \`\`\`abc fenced block.`;
    abc = extractAbc(await askComposer(composer, composerSystem, user));
    say(`Received ${abc.split("\n").length} lines of ABC.`);
  }

  /* ------------------- validate + fix (inner retry loop) ---------------- */
  const ensureValid = async (reason: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= cfg.loop.maxValidationRetries; attempt++) {
      const v = await validator.validate({ notation: abc, title, style: req.style });
      if (v.valid) {
        if (v.warnings.length) {
          say(`Valid (${reason}). Warnings: ${v.warnings.join("; ")}`);
        } else {
          say(`Valid (${reason}).`);
        }
        return true;
      }
      say(`Invalid ABC (${reason}) attempt ${attempt}/${cfg.loop.maxValidationRetries}:`);
      for (const e of v.errors) say(`  - ${e}`);
      if (attempt === cfg.loop.maxValidationRetries) return false;
      const user =
        `The following ABC score FAILED validation. Fix EVERY error and return the ` +
        `complete corrected score in a \`\`\`abc fenced block.\n\n` +
        `Errors:\n${v.errors.map((e) => `- ${e}`).join("\n")}\n\n` +
        `Original request: ${req.request}\n\n${factsBlock(abc)}Current ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
      abc = extractAbc(await askComposer(composer, composerSystem, user));
      say("Resubmitted corrected ABC.");
    }
    return false;
  };

  let valid = await ensureValid("initial");
  const validationWarnings: string[] = [];

  /* ------------------------ critique / iterate -------------------------- */
  let criticReport: CriticReport | null = null;
  let best: { abc: string; report: CriticReport } | null = null;
  let iterations = 0;

  for (let iter = 0; iter < cfg.loop.maxIterations; iter++) {
    iterations = iter + 1;
    say(`Critique pass ${iterations}/${cfg.loop.maxIterations}...`);
    const user =
      `Original request: ${req.request}\n${styleLine}` +
      (gapFill
        ? `NOTE: this is a GAP-FILL. The piece already existed; only ${analyzeScore(originalAbc).gaps.join("; ")} ` +
          `(the gap) were newly written. Judge ONLY those bars: do they fit the surrounding key, harmony, ` +
          `rhythm, texture and phrase shape, and do they lead naturally into the next bar? ` +
          `Do NOT criticise or suggest changes to any other bar.\n`
        : "") +
      `${factsBlock(abc)}Evaluate the following ABC score.\n\n\`\`\`abc\n${abc}\n\`\`\``;
    let report: CriticReport;
    let text = "";
    try {
      text = await critic.complete(criticSystem, user);
      report = coerceReport(extractJson<any>(text), text);
    } catch (e: any) {
      say(`Critic response unparseable (${e?.message ?? e}); salvaging score from raw text.`);
      report = coerceReport({ score: salvageScore(text), summary: "Critic output unparseable." }, text);
    }
    criticReport = report;
    say(`Score: ${report.score}/10 - ${report.summary}`);
    if (!best || report.score >= best.report.score) best = { abc, report };

    if (report.score >= cfg.loop.scoreThreshold) {
      say(`Score meets threshold (${cfg.loop.scoreThreshold}); stopping early.`);
      break;
    }
    if (iter === cfg.loop.maxIterations - 1) {
      say("Max iterations reached.");
      break;
    }

    say("Revising based on critic feedback...");
    const reviseUser =
      `Revise the following ABC score to address the critic's feedback. Return the ` +
      `complete revised score in a \`\`\`abc fenced block.\n\n` +
      `Original request: ${req.request}\n\n` +
      (gapFill
        ? `This is a GAP-FILL: modify ONLY the bars that were originally the gap (${analyzeScore(originalAbc).gaps.join("; ")}). ` +
          `Every other bar must stay exactly as it is now, even if the feedback below mentions it.\n\n`
        : isEdit
          ? `This is an EDIT of an existing piece: change nothing outside the edited passage.\n\n`
          : "") +
      `Critic issues:\n${report.issues.map((i) => `- ${i}`).join("\n") || "- (none listed)"}\n\n` +
      `Suggested revisions:\n${report.suggestions.map((s) => `- ${s}`).join("\n") || "- (none listed)"}\n\n` +
      `Strengths to preserve:\n${report.strengths.map((s) => `- ${s}`).join("\n") || "- (none listed)"}\n\n` +
      `${factsBlock(abc)}Current ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
    const beforeRevision = abc;
    abc = extractAbc(await askComposer(composer, composerSystem, reviseUser));
    valid = await ensureValid("revision");
    if (gapFill) {
      const bad = changesOutsideGaps(originalAbc, abc);
      if (bad.length) {
        say(`Guard: revision rejected, it changed music outside the gap (${bad.slice(0, 2).join("; ")}). Keeping the previous version.`);
        abc = beforeRevision;
        valid = true;
        break;
      }
    }
  }

  // A revision can make things worse: never return a version scoring below an earlier one.
  if (best && criticReport && best.report.score > criticReport.score) {
    say(`Keeping the best version (${best.report.score}/10), not the last one (${criticReport.score}/10).`);
    abc = best.abc;
    criticReport = best.report;
  }

  /* ----------------------- final validation ----------------------------- */
  const finalVal = await validator.validate({ notation: abc, title, style: req.style });
  validationWarnings.push(...finalVal.warnings, ...gapGuardWarnings);
  if (!finalVal.valid) valid = false;

  /* ----------------------------- render --------------------------------- */
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}-${crypto
    .randomUUID()
    .slice(0, 6)}`;
  const baseName = slugify(title);

  let files: string[] = [];
  if (!deps.noPersist) {
    say("Rendering...");
    const rendered = await renderAbc({
      abc,
      outDir: cfg.storage.dir,
      baseName: `${baseName}-${id.slice(-6)}`,
    });
    files = rendered.files;
    for (const f of files) say(`Wrote ${f}`);
  } else {
    say("Skipping render/store (dry run).");
  }

  /* ------------------------------ store --------------------------------- */
  const meta: ComposeResult = {
    id,
    title,
    style: req.style,
    request: req.request,
    abc,
    critic: criticReport,
    iterations,
    validationWarnings,
    files,
    composerModel: composerLabel,
    criticModel: criticLabel,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    log,
  };

  if (!deps.noPersist) {
    const store = new Store(cfg.storage);
    await store.init();
    const recordPath = await store.save(meta);
    say(`Stored record: ${recordPath}`);
  }

  if (!valid) {
    say("WARNING: final notation did not pass validation.");
  }

  return meta;
}

function deriveTitle(request: string): string {
  const cleaned = request.trim().replace(/\s+/g, " ");
  const short = cleaned.length > 60 ? cleaned.slice(0, 57) + "..." : cleaned;
  return short.replace(/^./, (c) => c.toUpperCase()) || "Untitled";
}
