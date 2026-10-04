// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Interactive, multi-turn sheet-music editor: load, edit, critique, transpose, save. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import type { AppConfig } from "../config.js";
import { clientForRole, describeRole } from "../llm/roles.js";
import { extractAbc, extractJson } from "../llm/parse.js";
import { createValidator } from "../validate/validator.js";
import { renderAbc } from "../render/renderer.js";
import { Store } from "../store/store.js";
import { analyzeScore, formatAnalysis, transposeAbc } from "../music/abc.js";
import { coerceReport, loadPrompt, slugify } from "./orchestrator.js";
import type { CriticReport } from "../types.js";

const COMPOSER_FALLBACK =
  "You are a classical composer and ABC-notation expert. Return only a complete, valid ABC score in a ```abc fenced block.";
const CRITIC_FALLBACK =
  'You are a music critic. Return only JSON: {"score":number,"strengths":[],"issues":[],"suggestions":[],"summary":""}.';

export interface SessionOptions {
  config: AppConfig;
  /** Resume a stored composition by id. */
  id?: string;
  /** Resume from an ABC file. */
  file?: string;
  style?: string;
  title?: string;
  onProgress?: (line: string) => void;
}

export async function runSession(opts: SessionOptions): Promise<void> {
  const cfg = opts.config;
  const say = opts.onProgress ?? ((l: string) => process.stdout.write(`  ${l}\n`));

  const validator = createValidator(cfg.validation);
  const composer = clientForRole(cfg, "composer");
  const critic = clientForRole(cfg, "critic");
  const composerSystem = await loadPrompt("composer", COMPOSER_FALLBACK);
  const criticSystem = await loadPrompt("critic", CRITIC_FALLBACK);

  let abc = "";
  let title = opts.title ?? "Untitled piece";
  let style = opts.style ?? "";
  let request = "interactive session";

  const facts = (a = abc): string =>
    `Score facts (deterministic, approximate):\n${formatAnalysis(analyzeScore(a))}`;

  const askComposer = async (system: string, user: string): Promise<string> => {
    const txt = composer.completeWithTools
      ? await composer.completeWithTools(system, user)
      : await composer.complete(system, user);
    return extractAbc(txt);
  };

  const ensureValid = async (candidate: string, reason: string): Promise<string> => {
    for (let attempt = 1; attempt <= cfg.loop.maxValidationRetries; attempt++) {
      const v = await validator.validate({ notation: candidate, title, style });
      if (v.valid) {
        say(`Valid (${reason})${v.warnings.length ? " — " + v.warnings.join("; ") : ""}.`);
        return candidate;
      }
      say(`Invalid (${reason}) attempt ${attempt}/${cfg.loop.maxValidationRetries}: ${v.errors.join("; ")}`);
      const user =
        `The following ABC score FAILED validation. Fix EVERY error and return the ` +
        `complete corrected score in a \`\`\`abc fenced block.\n\n` +
        `Errors:\n${v.errors.map((e) => `- ${e}`).join("\n")}\n\n` +
        `${facts(candidate)}\nCurrent ABC:\n\`\`\`abc\n${candidate}\n\`\`\``;
      candidate = await askComposer(composerSystem, user);
    }
    return candidate;
  };

  if (opts.id) {
    const store = new Store(cfg.storage);
    await store.init();
    const rec = await store.get(opts.id);
    if (!rec) {
      console.error(`No composition found for id "${opts.id}".`);
      return;
    }
    abc = rec.abc;
    title = rec.title;
    style = rec.style ?? "";
    request = rec.request;
    say(`Loaded "${title}" (${rec.id}).`);
  } else if (opts.file) {
    abc = await fs.readFile(opts.file, "utf8");
    title = path.basename(opts.file, path.extname(opts.file));
    say(`Loaded ABC from ${opts.file}.`);
    abc = await ensureValid(abc, "load");
  } else {
    say("Empty session — /compose <request> or /edit <instruction>.");
  }

  const printReport = (r: CriticReport) => {
    console.log(`Score: ${r.score}/10 — ${r.summary || ""}`);
    if (r.issues.length) {
      console.log("Issues:");
      for (const i of r.issues) console.log(`  - ${i}`);
    }
    if (r.suggestions.length) {
      console.log("Suggestions:");
      for (const s of r.suggestions) console.log(`  - ${s}`);
    }
  };

  const saveCurrent = async () => {
    if (!abc) {
      console.error("No ABC to save.");
      return;
    }
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}-${crypto
      .randomUUID()
      .slice(0, 6)}`;
    const baseName = `${slugify(title)}-${id.slice(-6)}`;
    const rendered = await renderAbc({
      abc,
      outDir: cfg.storage.dir,
      baseName,
      prefer: cfg.render.prefer,
      formats: cfg.render.formats,
      abc2svgPath: cfg.render.abc2svgPath,
      abcm2psPath: cfg.render.abcm2psPath,
    });
    const meta = {
      id,
      title,
      style: style || undefined,
      request,
      abc,
      critic: null,
      iterations: 0,
      validationWarnings: [],
      files: rendered.files,
      engine: rendered.engine,
      composerModel: describeRole(cfg, "composer"),
      criticModel: describeRole(cfg, "critic"),
      createdAt: new Date().toISOString(),
    };
    const store = new Store(cfg.storage);
    await store.init();
    const recPath = await store.save(meta);
    say(`Saved "${title}" (${id}) -> ${recPath}`);
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    "Commands: /abc /analyze /show /edit <ins> /critique /compose <req> /transpose <n> /save /export <file> /help /quit",
  );

  while (true) {
    let raw = "";
    try {
      raw = (await rl.question("music> ")).trim();
    } catch {
      break; // EOF / stream closed
    }
    if (!raw) continue;
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ");

    try {
      switch (cmd) {
        case "/quit":
        case "/exit":
        case "/q":
          rl.close();
          return;
        case "/help":
          console.log(
            "/abc /analyze /show /edit <ins> /critique /compose <req> /transpose <n> /save /export <file> /help /quit",
          );
          break;
        case "/abc":
          console.log(abc || "(empty)");
          break;
        case "/analyze":
          console.log(abc ? facts() : "(no ABC loaded)");
          break;
        case "/show":
          console.log(`Title:   ${title}`);
          console.log(`Style:   ${style || "(none)"}`);
          console.log(`Request: ${request}`);
          console.log(abc ? facts() : "(no ABC loaded)");
          break;
        case "/compose": {
          if (!arg) {
            console.error("usage: /compose <request>");
            break;
          }
          request = arg;
          title = opts.title ?? arg.slice(0, 60);
          const user =
            `Compose a piece.\n\nRequest: ${arg}\n${style ? `Style/period: ${style}\n` : ""}` +
            `Title suggestion: ${title}\n\nReturn the full ABC score in a single \`\`\`abc fenced block.`;
          abc = await ensureValid(await askComposer(composerSystem, user), "initial");
          break;
        }
        case "/edit": {
          if (!abc) {
            console.error("No ABC loaded — /compose <request> first.");
            break;
          }
          if (!arg) {
            console.error("usage: /edit <instruction>");
            break;
          }
          const before = abc.length;
          const user =
            `Revise the following ABC score.\n\nInstruction: ${arg}\n\n${facts()}\n` +
            `Current ABC:\n\`\`\`abc\n${abc}\n\`\`\``;
          abc = await ensureValid(await askComposer(composerSystem, user), "edit");
          say(`Edited (${before} -> ${abc.length} chars).`);
          break;
        }
        case "/critique": {
          if (!abc) {
            console.error("No ABC loaded.");
            break;
          }
          const user =
            `Original request: ${request}\n${facts()}\nEvaluate the following ABC score.\n\n` +
            `\`\`\`abc\n${abc}\n\`\`\``;
          const text = await critic.complete(criticSystem, user);
          printReport(coerceReport(extractJson(text), text));
          break;
        }
        case "/transpose": {
          if (!abc) {
            console.error("No ABC loaded.");
            break;
          }
          const n = Number.parseInt(arg, 10);
          if (!Number.isInteger(n)) {
            console.error("usage: /transpose <semitones>");
            break;
          }
          abc = await ensureValid(transposeAbc(abc, n), `transpose ${n}`);
          break;
        }
        case "/export": {
          if (!arg) {
            console.error("usage: /export <path>");
            break;
          }
          await fs.writeFile(arg, abc);
          console.log(`wrote ${arg}`);
          break;
        }
        case "/save":
          await saveCurrent();
          break;
        default:
          console.error(`unknown "${cmd}" — /help for commands.`);
      }
    } catch (e: any) {
      console.error(`error: ${e?.message ?? String(e)}`);
    }
  }
}