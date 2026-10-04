#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** CLI entry point for the pi-music-agent harness. */

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { composePiece } from "./loop/orchestrator.js";
import { runSession } from "./loop/session.js";
import { createValidator } from "./validate/validator.js";
import { renderAbc } from "./render/renderer.js";
import { Store } from "./store/store.js";
import { analyzeScore, formatAnalysis, parseHeaders, transposeAbc } from "./music/abc.js";
import { convertSheetMusic } from "./convert/convert.js";

const program = new Command();

program
  .name("music-agent")
  .description("Classical music harness: compose -> validate -> critique -> render -> store (ABC).")
  .version("0.1.0");

/* ------------------------------- compose --------------------------------- */
program
  .command("compose")
  .description("Compose a new piece from a text request.")
  .argument("<request>", 'e.g. "a wistful baroque minuet in D minor"')
  .option("-s, --style <style>", "style/period hint, e.g. baroque, romantic")
  .option("-t, --title <title>", "title for the piece")
  .option("-f, --file <abc>", "start from an existing ABC file instead of composing")
  .option("-r, --refs <dir>", "read reference .abc files from a dir (e.g. input/) to emulate")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--dry-run", "skip rendering and storage", false)
  .option("--json", "emit the full result as JSON on stdout", false)
  .action(async (request: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const existingAbc = opts.file ? await fs.readFile(opts.file, "utf8") : undefined;
    const references = opts.refs ? await readAbcFiles(opts.refs) : undefined;
    const result = await composePiece(
      { request, style: opts.style, title: opts.title, existingAbc, references },
      {
        config: cfg,
        noPersist: opts.dryRun,
        onProgress: opts.json ? undefined : (l) => console.error(`  ${l}`),
      },
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("");
    console.log(`Title:      ${result.title}`);
    console.log(`Id:         ${result.id}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Score:      ${result.critic ? `${result.critic.score}/10` : "n/a"}`);
    if (result.critic?.summary) console.log(`Critic:     ${result.critic.summary}`);
    console.log(`Engine:     ${result.engine}`);
    console.log(`Took:       ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.files.length) {
      console.log("Files:");
      for (const f of result.files) console.log(`  ${f}`);
    }
    console.log("");
    console.log("---- ABC ----");
    console.log(result.abc);
  });

/* --------------------------------- edit ---------------------------------- */
program
  .command("edit")
  .description('Edit an existing ABC file with an instruction, e.g. "fill in the gap".')
  .argument("<file>", "ABC file to edit")
  .argument("<instruction>", 'what to change, e.g. "fill in the gap in bars 5-6"')
  .option("-s, --style <style>", "style/period hint")
  .option("-t, --title <title>", "title for the saved result")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--dry-run", "skip rendering and storage", false)
  .option("--json", "emit the full result as JSON on stdout", false)
  .action(async (file: string, instruction: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const existingAbc = await fs.readFile(file, "utf8");
    const title = opts.title ?? parseHeaders(existingAbc).t ?? path.basename(file, path.extname(file));
    const result = await composePiece(
      { request: instruction, style: opts.style, title, existingAbc, edit: true },
      {
        config: cfg,
        noPersist: opts.dryRun,
        onProgress: opts.json ? undefined : (l) => console.error(`  ${l}`),
      },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log("");
    console.log(`Title:      ${result.title}`);
    console.log(`Score:      ${result.critic ? `${result.critic.score}/10` : "n/a"}`);
    if (result.files.length) {
      console.log("Files:");
      for (const f of result.files) console.log(`  ${f}`);
    }
    console.log("\n---- ABC ----");
    console.log(result.abc);
  });

/* ------------------------------- validate -------------------------------- */
program
  .command("validate")
  .description("Validate an ABC file (or stdin with '-').")
  .argument("[file]", "ABC file path, or - for stdin")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--json", "emit raw JSON", false)
  .action(async (file: string | undefined, opts: any) => {
    const cfg = loadConfig(opts.config);
    const notation =
      !file || file === "-"
        ? await readStdin()
        : await fs.readFile(file, "utf8");
    const validator = createValidator(cfg.validation);
    const result = await validator.validate({ notation });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`backend:  ${result.backend}`);
      console.log(`valid:    ${result.valid}`);
      if (result.errors.length) {
        console.log("errors:");
        for (const e of result.errors) console.log(`  - ${e}`);
      }
      if (result.warnings.length) {
        console.log("warnings:");
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
    }
    process.exit(result.valid ? 0 : 1);
  });

/* -------------------------------- render --------------------------------- */
program
  .command("render")
  .description("Render an ABC file to SVG/HTML.")
  .argument("<file>", "ABC file path")
  .option("-o, --out <dir>", "output directory (defaults to config storage dir)")
  .option("-n, --name <name>", "base file name")
  .option("--formats <csv>", "comma-separated output formats: svg, html")
  .option("-c, --config <path>", "path to config.yaml")
  .action(async (file: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const abc = await fs.readFile(file, "utf8");
    const baseName = opts.name ?? path.basename(file, path.extname(file));
    const formats = (opts.formats ?? cfg.render.formats.join(","))
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const result = await renderAbc({
      abc,
      outDir: path.resolve(process.cwd(), opts.out ?? cfg.storage.dir),
      baseName,
      prefer: cfg.render.prefer,
      formats,
      abc2svgPath: cfg.render.abc2svgPath,
      abcm2psPath: cfg.render.abcm2psPath,
    });
    console.log(`engine: ${result.engine}`);
    for (const w of result.warnings) console.log(`warning: ${w}`);
    for (const f of result.files) console.log(`wrote ${f}`);
  });

/* --------------------------------- list ---------------------------------- */
program
  .command("list")
  .description("List stored compositions.")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--json", "emit raw index entries as JSONL", false)
  .action(async (opts: any) => {
    const cfg = loadConfig(opts.config);
    const store = new Store(cfg.storage);
    await store.init();
    const items = await store.list();
    if (!items.length) {
      console.log("No compositions stored yet.");
      return;
    }
    if (opts.json) {
      for (const it of items) console.log(JSON.stringify(it));
      return;
    }
    for (const it of items as any[]) {
      const score = it.critic?.score ?? it.score ?? "?";
      const style = it.style ?? "-";
      const nFiles = Array.isArray(it.files) ? it.files.length : 0;
      console.log(
        `${it.createdAt ?? ""}  ${score}/10  ${style}  ${it.title ?? it.id}  (${nFiles} file${nFiles === 1 ? "" : "s"})  [${it.id}]`,
      );
    }
  });

/* --------------------------------- show ---------------------------------- */
program
  .command("show")
  .description("Show a stored composition by id.")
  .argument("<id>", "composition id (see `music-agent list`)")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--abc", "print only the ABC notation", false)
  .option("--json", "dump the full stored record as JSON", false)
  .action(async (id: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const store = new Store(cfg.storage);
    await store.init();
    const rec = await store.get(id);
    if (!rec) {
      console.error(`No composition found for id "${id}".`);
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    if (opts.abc) {
      console.log(rec.abc);
      return;
    }
    console.log(`Title:   ${rec.title}`);
    console.log(`Id:      ${rec.id}`);
    if (rec.style) console.log(`Style:   ${rec.style}`);
    console.log(`Request: ${rec.request}`);
    console.log(`Created: ${rec.createdAt}`);
    const score = rec.critic?.score;
    console.log(`Score:   ${score != null ? `${score}/10` : "n/a"}`);
    if (rec.critic?.summary) console.log(`Critic:  ${rec.critic.summary}`);
    if (rec.critic?.issues?.length) {
      console.log("Issues:");
      for (const i of rec.critic.issues) console.log(`  - ${i}`);
    }
    if (rec.critic?.suggestions?.length) {
      console.log("Suggestions:");
      for (const s of rec.critic.suggestions) console.log(`  - ${s}`);
    }
    if (rec.files?.length) {
      console.log("Files:");
      for (const f of rec.files) console.log(`  ${f}`);
    }
    console.log("");
    console.log("---- ABC ----");
    console.log(rec.abc);
  });

/* ------------------------------- transpose ------------------------------- */
program
  .command("transpose")
  .description("Transpose an ABC file (or stdin with '-') by a number of semitones.")
  .argument("<semitones>", "number of semitones (negative to go down)")
  .argument("[file]", "ABC file path, or - for stdin")
  .option("-o, --out <dir>", "output dir (defaults to storage output dir)")
  .option("-c, --config <path>", "path to config.yaml")
  .action(async (semitones: string, file: string | undefined, opts: any) => {
    const n = Number.parseInt(semitones, 10);
    if (!Number.isInteger(n)) {
      console.error("semitones must be an integer.");
      process.exit(1);
    }
    const cfg = loadConfig(opts.config);
    const notation = !file || file === "-" ? await readStdin() : await fs.readFile(file, "utf8");
    const abc = transposeAbc(notation, n);
    const outDir = path.resolve(process.cwd(), opts.out ?? cfg.storage.dir);
    await fs.mkdir(outDir, { recursive: true });
    const base = file && file !== "-" ? path.basename(file, path.extname(file)) : "transposed";
    const outPath = path.join(outDir, `${base}.abc`);
    await fs.writeFile(outPath, abc + "\n");
    console.log(`wrote ${outPath}`);
  });

/* -------------------------------- analyze -------------------------------- */
program
  .command("analyze")
  .description("Deterministically analyze an ABC file (or stdin with '-').")
  .argument("[file]", "ABC file path, or - for stdin")
  .action(async (file: string | undefined) => {
    const notation = !file || file === "-" ? await readStdin() : await fs.readFile(file, "utf8");
    console.log(formatAnalysis(analyzeScore(notation)));
  });

/* -------------------------------- convert -------------------------------- */
program
  .command("convert")
  .description("Convert sheet music (PDF/image/MusicXML) or an ABC file into validated ABC.")
  .argument("<input>", "input file path (PDF, image, MusicXML, or .abc)")
  .option("-o, --out <dir>", "output dir for the .abc (defaults to storage output dir)")
  .option("-c, --config <path>", "path to config.yaml")
  .option("--json", "emit machine-readable result", false)
  .action(async (inputPath: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const result = await convertSheetMusic(inputPath, cfg);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`backend: ${result.backend}`);
      console.log(`valid:   ${result.valid}`);
      for (const w of result.warnings) console.log(`warning: ${w}`);
      for (const e of result.errors) console.log(`error:   ${e}`);
    }
    if (!result.valid) process.exit(1);
    const outDir = path.resolve(process.cwd(), opts.out ?? cfg.storage.dir);
    await fs.mkdir(outDir, { recursive: true });
    const base =
      path.basename(inputPath, path.extname(inputPath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "piece";
    const outPath = path.join(outDir, `${base}.abc`);
    await fs.writeFile(outPath, result.abc + "\n");
    if (!opts.json) console.log(`wrote    ${outPath}`);
  });

/* -------------------------------- session -------------------------------- */
program
  .command("session")
  .description("Start an interactive composition/editing session.")
  .argument("[id]", "resume a stored composition by id (see `list`)")
  .option("-f, --file <abc>", "resume from an ABC file")
  .option("-s, --style <style>", "style/period hint")
  .option("-t, --title <title>", "title hint")
  .option("-c, --config <path>", "path to config.yaml")
  .action(async (id: string | undefined, opts: any) => {
    const cfg = loadConfig(opts.config);
    await runSession({ config: cfg, id, file: opts.file, style: opts.style, title: opts.title });
  });

/* -------------------------------- config --------------------------------- */
program
  .command("config")
  .description("Print the resolved configuration (secrets redacted).")
  .option("-c, --config <path>", "path to config.yaml")
  .action((opts: any) => {
    const cfg = loadConfig(opts.config);
    const redacted = JSON.parse(JSON.stringify(cfg));
    for (const p of Object.values<any>(redacted.providers)) {
      if (p.apiKey) p.apiKey = "***redacted***";
    }
    console.log(JSON.stringify(redacted, null, 2));
  });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readAbcFiles(dir: string): Promise<string[]> {
  const abs = path.resolve(process.cwd(), dir);
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(abs)).filter((f) => f.toLowerCase().endsWith(".abc"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) out.push(await fs.readFile(path.join(abs, e), "utf8"));
  return out;
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
