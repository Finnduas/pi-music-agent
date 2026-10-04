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
import { createValidator } from "../validate/validator.js";
import { renderAbc } from "../render/renderer.js";
import { Store } from "../store/store.js";
import type { ComposeRequest, ComposeResult, CriticReport } from "../types.js";

async function loadPrompt(name: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(path.join(projectRoot, "prompts", `${name}.md`), "utf8");
  } catch {
    return fallback;
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function coerceReport(raw: any, fallbackText: string): CriticReport {
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
  if (abc) {
    say("Starting from supplied ABC (skipping initial composition).");
  } else {
    say("Composing initial sketch...");
    const user =
      `Compose a piece.\n\nRequest: ${req.request}\n${styleLine}` +
      `Title suggestion: ${title}\n\n` +
      `Return the full ABC score in a single \`\`\`abc fenced block.`;
    abc = extractAbc(await composer.complete(composerSystem, user));
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
        `Original request: ${req.request}\n\nCurrent ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
      abc = extractAbc(await composer.complete(composerSystem, user));
      say("Resubmitted corrected ABC.");
    }
    return false;
  };

  let valid = await ensureValid("initial");
  const validationWarnings: string[] = [];

  /* ------------------------ critique / iterate -------------------------- */
  let criticReport: CriticReport | null = null;
  let iterations = 0;

  for (let iter = 0; iter < cfg.loop.maxIterations; iter++) {
    iterations = iter + 1;
    say(`Critique pass ${iterations}/${cfg.loop.maxIterations}...`);
    const user =
      `Original request: ${req.request}\n${styleLine}` +
      `Evaluate the following ABC score.\n\n\`\`\`abc\n${abc}\n\`\`\``;
    let report: CriticReport;
    try {
      const text = await critic.complete(criticSystem, user);
      report = coerceReport(extractJson<any>(text), text);
    } catch (e: any) {
      say(`Critic response unparseable (${e?.message ?? e}); treating as score 0.`);
      report = coerceReport({ score: 0, summary: "Critic output unparseable." }, "");
    }
    criticReport = report;
    say(`Score: ${report.score}/10 - ${report.summary}`);

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
      `Critic issues:\n${report.issues.map((i) => `- ${i}`).join("\n") || "- (none listed)"}\n\n` +
      `Suggested revisions:\n${report.suggestions.map((s) => `- ${s}`).join("\n") || "- (none listed)"}\n\n` +
      `Strengths to preserve:\n${report.strengths.map((s) => `- ${s}`).join("\n") || "- (none listed)"}\n\n` +
      `Current ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
    abc = extractAbc(await composer.complete(composerSystem, reviseUser));
    valid = await ensureValid("revision");
  }

  /* ----------------------- final validation ----------------------------- */
  const finalVal = await validator.validate({ notation: abc, title, style: req.style });
  validationWarnings.push(...finalVal.warnings);
  if (!finalVal.valid) valid = false;

  /* ----------------------------- render --------------------------------- */
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}-${crypto
    .randomUUID()
    .slice(0, 6)}`;
  const baseName = slugify(title);

  let files: string[] = [];
  let engine = "none";
  if (!deps.noPersist) {
    say("Rendering...");
    const rendered = await renderAbc({
      abc,
      outDir: cfg.storage.dir,
      baseName: `${baseName}-${id.slice(-6)}`,
      prefer: cfg.render.prefer,
      formats: cfg.render.formats,
      abc2svgPath: cfg.render.abc2svgPath,
      abcm2psPath: cfg.render.abcm2psPath,
    });
    files = rendered.files;
    engine = rendered.engine;
    for (const w of rendered.warnings) say(`Render: ${w}`);
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
    engine,
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
