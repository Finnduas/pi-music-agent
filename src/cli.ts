#!/usr/bin/env node
/** CLI entry point for the pi-music-agent harness. */

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { composePiece } from "./loop/orchestrator.js";
import { createValidator } from "./validate/validator.js";
import { renderAbc } from "./render/renderer.js";
import { Store } from "./store/store.js";

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
  .option("-c, --config <path>", "path to config.yaml")
  .option("--dry-run", "skip rendering and storage", false)
  .option("--json", "emit the full result as JSON on stdout", false)
  .action(async (request: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const existingAbc = opts.file ? await fs.readFile(opts.file, "utf8") : undefined;
    const result = await composePiece(
      { request, style: opts.style, title: opts.title, existingAbc },
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
  .option("-c, --config <path>", "path to config.yaml")
  .action(async (file: string, opts: any) => {
    const cfg = loadConfig(opts.config);
    const abc = await fs.readFile(file, "utf8");
    const baseName = opts.name ?? path.basename(file, path.extname(file));
    const result = await renderAbc({
      abc,
      outDir: path.resolve(process.cwd(), opts.out ?? cfg.storage.dir),
      baseName,
      prefer: cfg.render.prefer,
      formats: cfg.render.formats,
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
  .action(async (opts: any) => {
    const cfg = loadConfig(opts.config);
    const store = new Store(cfg.storage);
    await store.init();
    const items = await store.list();
    if (!items.length) {
      console.log("No compositions stored yet.");
      return;
    }
    for (const it of items) {
      const score = (it as any).critic?.score ?? (it as any).score ?? "?";
      console.log(`${it.createdAt ?? ""}  ${score}/10  ${it.title ?? it.id}  [${it.id}]`);
    }
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
