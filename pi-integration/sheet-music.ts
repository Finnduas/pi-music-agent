// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Pi extension: drives the pi-music-agent CLI as a MUSIC tool.
 *
 * Music tasks (compose, transpose, convert sheet music -> ABC) go through the
 * agent CLI. This extension must NOT edit the music agent's own source code —
 * it only invokes `node <dir>/dist/cli.js ...` and reports results.
 *
 * Install: copy this file to ~/.pi/agent/extensions/sheet-music.ts
 * (or set MUSIC_AGENT_DIR to a checkout of pi-music-agent).
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MUSIC_DIR = resolveMusicDir();

function resolveMusicDir(): string | null {
  const explicit = process.env.MUSIC_AGENT_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "package.json"))) return path.resolve(explicit);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [path.join(home, "pi-music-agent"), path.join(process.cwd() ?? "", "pi-music-agent")];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "package.json"))) return c;
  }
  return null;
}

function cliPath(): string | null {
  if (!MUSIC_DIR) return null;
  const p = path.join(MUSIC_DIR, "dist", "cli.js");
  return fs.existsSync(p) ? p : null;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(pi: ExtensionAPI, args: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<RunResult> {
  const cli = cliPath();
  if (!cli) {
    return {
      ok: false,
      stdout: "",
      stderr: MUSIC_DIR
        ? "pi-music-agent is not built yet — run `npm run build` in " + MUSIC_DIR
        : "pi-music-agent not found — set MUSIC_AGENT_DIR to its checkout.",
      code: 1,
    };
  }
  const r = await pi.exec("node", [cli, ...args], {
    cwd: MUSIC_DIR!,
    timeout: opts?.timeout ?? 300000,
    signal: opts?.signal,
  });
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr, code: r.code };
}

/** Resolve a user-supplied path: Pi's cwd first, then the music agent folder (so ".input/x.abc" works). */
function resolveFile(file: string): string {
  if (path.isAbsolute(file)) return file;
  const here = path.resolve(process.cwd(), file);
  if (fs.existsSync(here)) return here;
  if (MUSIC_DIR) {
    const there = path.resolve(MUSIC_DIR, file);
    if (fs.existsSync(there)) return there;
  }
  return here;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

async function readAbc(file: string): Promise<string> {
  return fs.promises.readFile(file, "utf8");
}

export default function (pi: ExtensionAPI) {
  /* ------------------------------ model tools ------------------------------ */

  pi.registerTool({
    name: "sheetmusic_compose",
    label: "Compose sheet music",
    promptSnippet: "sheetmusic_compose: write a new piece of sheet music (ABC), optionally in the style of reference files",
    promptGuidelines: [
      "Never write ABC notation yourself for a music request; call the sheetmusic_* tools.",
      "When the user wants a piece based on, in the style of, or inspired by existing files or a folder, pass that folder as sheetmusic_compose refDir (the tool reads the .abc files itself; you do not need to read or paste them). Keep `request` about the music wanted, and never put file paths in `title`.",
      "Call sheetmusic_compose once per request; only call it again if the user asks for another version.",
    ],
    description:
      "Compose a new piece of sheet music in ABC notation. Runs the full compose -> validate -> critique -> render loop. Use when asked to write, generate, or create a musical score, optionally in the style of reference pieces.",
    parameters: Type.Object({
      request: Type.String({ description: "Musical request, e.g. 'a wistful baroque minuet in D minor'" }),
      style: Type.Optional(Type.String({ description: "Style/period hint, e.g. baroque, romantic" })),
      title: Type.Optional(Type.String({ description: "Optional title" })),
      refDir: Type.Optional(Type.String({ description: "Folder of reference .abc files whose style to emulate, e.g. 'examples/input' or '.input'. Pass this whenever the user wants a piece based on / in the style of existing music." })),
    }),
    async execute(_id, params, signal): Promise<any> {
      const args = ["compose", params.request, "--json"];
      if (params.style) args.push("--style", params.style);
      if (params.title) args.push("--title", params.title);
      // Models often forget refDir; if the request points at the input folder, supply it.
      let refDir = params.refDir;
      if (!refDir) {
        const m = /(examples\/input|\.input)\b/i.exec(params.request) ?? (/\binput (folder|pieces|files|dir)/i.test(params.request) ? ["", ".input"] : null);
        if (m) refDir = m[1];
      }
      if (refDir) args.push("--refs", resolveFile(refDir));
      const r = await runCli(pi, args, { timeout: 600000, signal });
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Composition failed:\n${r.stderr}\n${r.stdout}` }],
          details: { error: r.stderr },
        };
      }
      let rec: any = null;
      try { rec = JSON.parse(r.stdout); } catch { return { content: [{ type: "text", text: r.stdout }], details: {} }; }
      const text = [
        `Composed "${rec.title}" (id ${rec.id})`,
        `Critic score: ${rec.critic?.score ?? "n/a"}/10`,
        `Files: ${(rec.files ?? []).join(", ") || "(none)"}`,
        "",
        "ABC notation:",
        truncate(rec.abc ?? "", 6000),
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { id: rec.id, title: rec.title, score: rec.critic?.score, files: rec.files, abc: rec.abc, engine: rec.engine },
      };
    },
  });

  pi.registerTool({
    name: "sheetmusic_transpose",
    label: "Transpose sheet music",
    promptSnippet: "sheetmusic_transpose: move an ABC score by N semitones (deterministic, exact)",
    promptGuidelines: [
      "To rewrite a piece in another key: sheetmusic_analyze for the current key, work out the semitone shift (the short way, e.g. C to F is +5), then call sheetmusic_transpose. Never transpose by hand.",
    ],
    description:
      'Transpose an ABC score by a number of semitones (e.g. "rewrite this in F major" = transpose by the right number of semitones). Writes the result to the output folder.',
    parameters: Type.Object({
      file: Type.String({ description: "Path to the .abc file to transpose" }),
      semitones: Type.Number({ description: "Number of semitones (negative to go down)" }),
    }),
    async execute(_id, params, signal): Promise<any> {
      const r = await runCli(pi, ["transpose", String(params.semitones), resolveFile(params.file)], { signal });
      if (!r.ok) return { content: [{ type: "text", text: `Transpose failed:\n${r.stderr}` }], details: { error: r.stderr } };
      const outPath = r.stdout.replace("wrote ", "").trim();
      const abc = await readAbc(outPath).catch(() => "");
      return {
        content: [{ type: "text", text: `Transposed ${params.file} by ${params.semitones} semitones.\nWrote: ${outPath}\n\nABC:\n${truncate(abc, 6000)}` }],
        details: { file: outPath, abc, semitones: params.semitones },
      };
    },
  });

  pi.registerTool({
    name: "sheetmusic_convert",
    label: "Convert sheet music to ABC",
    description:
      "Convert sheet music (PDF, image, or MusicXML) into ABC notation — the intermediate language the music agent works with. Drops into the configured input folder.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to a PDF/image/MusicXML file (or .abc to validate+copy)" }),
    }),
    async execute(_id, params, signal): Promise<any> {
      const r = await runCli(pi, ["convert", resolveFile(params.file), "--json"], { signal });
      if (!r.ok) return { content: [{ type: "text", text: `Conversion failed:\n${r.stderr}\n${r.stdout}` }], details: { error: r.stderr } };
      let rec: any = null;
      try { rec = JSON.parse(r.stdout); } catch { return { content: [{ type: "text", text: r.stdout }], details: {} }; }
      return {
        content: [
          { type: "text", text: `Converted to ABC (valid: ${rec.valid}).\nBackend: ${rec.backend}\n\n${truncate(rec.abc ?? "", 6000)}` },
        ],
        details: { valid: rec.valid, backend: rec.backend, abc: rec.abc, errors: rec.errors, warnings: rec.warnings },
      };
    },
  });

  pi.registerTool({
    name: "sheetmusic_analyze",
    label: "Analyze sheet music",
    description:
      "Deterministically analyze an ABC file: bars, meter, key, tonic, voices, whether it ends on the tonic, and candidate GAPS (rest-only or 'GAP'-marked bars). Free and instant (no LLM). Call this FIRST for 'what key is this' or 'fill in the gap' requests.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the .abc file" }),
    }),
    async execute(_id, params, signal): Promise<any> {
      const r = await runCli(pi, ["analyze", resolveFile(params.file)], { signal });
      if (!r.ok) return { content: [{ type: "text", text: `Analyze failed:
${r.stderr}` }], details: { error: r.stderr } };
      return { content: [{ type: "text", text: r.stdout.trim() }], details: { file: params.file } };
    },
  });

  pi.registerTool({
    name: "sheetmusic_edit",
    label: "Edit sheet music",
    promptSnippet: "sheetmusic_edit: change an existing ABC score with an instruction (e.g. fill in the gap)",
    promptGuidelines: [
      "For 'fill in the gap', call sheetmusic_analyze first and put the reported bar numbers in the sheetmusic_edit instruction. Call sheetmusic_edit once; for gap-fills the tool guarantees that nothing outside the gap changes.",
    ],
    description:
      "Edit an existing ABC score with a natural-language instruction, e.g. 'fill in the gap', 'make bars 5-8 more lyrical'. Keeps everything else unchanged, then validates, critiques and renders the result. Use sheetmusic_analyze first to see where the gaps are.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the .abc file to edit" }),
      instruction: Type.String({ description: "What to change, e.g. 'fill in the gap in bars 5-6'" }),
      style: Type.Optional(Type.String({ description: "Style/period hint" })),
    }),
    async execute(_id, params, signal): Promise<any> {
      const args = ["edit", resolveFile(params.file), params.instruction, "--json"];
      if (params.style) args.push("--style", params.style);
      const r = await runCli(pi, args, { timeout: 600000, signal });
      if (!r.ok) return { content: [{ type: "text", text: `Edit failed:\n${r.stderr}\n${r.stdout}` }], details: { error: r.stderr } };
      let rec: any = null;
      try { rec = JSON.parse(r.stdout); } catch { return { content: [{ type: "text", text: r.stdout }], details: {} }; }
      const text = [
        `Edited "${rec.title}" (id ${rec.id}) — critic ${rec.critic?.score ?? "n/a"}/10`,
        `Files: ${(rec.files ?? []).join(", ") || "(none)"}`,
        "",
        "ABC notation:",
        truncate(rec.abc ?? "", 6000),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { id: rec.id, files: rec.files, abc: rec.abc, score: rec.critic?.score } };
    },
  });

  /* ---------------------------- slash commands ----------------------------- */

  const notify = (ctx: any, msg: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, type);

  pi.registerCommand("compose", {
    description: "Compose a piece of sheet music (ABC) from a request",
    handler: async (args, ctx) => {
      const { style, refDir, request } = parseComposeArgs(args);
      if (!request) {
        notify(ctx, "usage: /compose [--style <s>] [--refs <dir>] <request>", "warning");
        return;
      }
      notify(ctx, "Composing… (compose -> validate -> critique -> render)", "info");
      const opts = ["compose", request, "--json"];
      if (style) opts.push("--style", style);
      if (refDir) opts.push("--refs", resolveFile(refDir));
      const r = await runCli(pi, opts, { timeout: 600000 });
      if (!r.ok) return notify(ctx, `Compose failed:\n${r.stderr}\n${r.stdout}`, "error");
      try {
        const rec = JSON.parse(r.stdout);
        notify(ctx, `Composed "${rec.title}" — ${rec.critic?.score ?? "?"}/10 · ${rec.files.length} file(s)`, "info");
        if (rec.files?.length) notify(ctx, `Files:\n${rec.files.join("\n")}`, "info");
        notify(ctx, `ABC:\n${truncate(rec.abc ?? "", 3000)}`, "info");
      } catch {
        notify(ctx, r.stdout || "No output.", "warning");
      }
    },
  });

  pi.registerCommand("music", {
    description: "Show sheet-music agent status and commands",
    handler: async (_args, ctx) => {
      const dir = MUSIC_DIR ?? "(not found — set MUSIC_AGENT_DIR)";
      notify(ctx, `pi-music-agent: ${dir}\nCommands: /compose /music-edit /music-list /music-analyze /music-transpose /music-render /music-validate /music-convert`, "info");
    },
  });

  pi.registerCommand("music-list", {
    description: "List stored sheet-music compositions",
    handler: async (_args, ctx) => {
      const r = await runCli(pi, ["list"]);
      notify(ctx, r.ok ? r.stdout.trim() : `list failed:\n${r.stderr}`, r.ok ? "info" : "error");
    },
  });

  pi.registerCommand("music-analyze", {
    description: "Analyze an ABC file (bars, meter, key, tonic, voices)",
    handler: async (args, ctx) => {
      if (!args.trim()) return notify(ctx, "usage: /music-analyze <file>", "warning");
      const r = await runCli(pi, ["analyze", resolveFile(args.trim())]);
      notify(ctx, r.ok ? r.stdout.trim() : r.stderr, r.ok ? "info" : "error");
    },
  });

  pi.registerCommand("music-transpose", {
    description: "Transpose an ABC file by semitones ('rewrite in F major' style)",
    handler: async (args, ctx) => {
      const [file, n] = args.trim().split(/\s+/);
      if (!file || !n) return notify(ctx, "usage: /music-transpose <file> <semitones>", "warning");
      const r = await runCli(pi, ["transpose", n, resolveFile(file)]);
      notify(ctx, r.ok ? r.stdout.trim() : r.stderr, r.ok ? "info" : "error");
    },
  });

  pi.registerCommand("music-edit", {
    description: "Edit a score with an instruction, e.g. /music-edit .input/piece.abc fill in the gap",
    handler: async (args, ctx) => {
      const m = /^(S+)s+(.+)$/.exec(args.trim());
      if (!m) return notify(ctx, "usage: /music-edit <file> <instruction>", "warning");
      notify(ctx, "Editing… (edit -> validate -> critique -> render)", "info");
      const r = await runCli(pi, ["edit", resolveFile(m[1]), m[2], "--json"], { timeout: 600000 });
      if (!r.ok) return notify(ctx, `Edit failed:\n${r.stderr}\n${r.stdout}`, "error");
      try {
        const rec = JSON.parse(r.stdout);
        notify(ctx, [`Edited "${rec.title}" — ${rec.critic?.score ?? "?"}/10`, "Files:", ...(rec.files ?? []), "", "ABC:", truncate(rec.abc ?? "", 3000)].join("\n"), "info");
      } catch {
        notify(ctx, r.stdout || "No output.", "warning");
      }
    },
  });

  pi.registerCommand("music-render", {
    description: "Render an ABC file to sheet music (HTML/SVG)",
    handler: async (args, ctx) => {
      if (!args.trim()) return notify(ctx, "usage: /music-render <file>", "warning");
      const r = await runCli(pi, ["render", resolveFile(args.trim())]);
      notify(ctx, r.ok ? r.stdout.trim() : r.stderr, r.ok ? "info" : "error");
    },
  });

  pi.registerCommand("music-validate", {
    description: "Validate an ABC file",
    handler: async (args, ctx) => {
      if (!args.trim()) return notify(ctx, "usage: /music-validate <file>", "warning");
      const r = await runCli(pi, ["validate", resolveFile(args.trim())]);
      notify(ctx, r.ok ? r.stdout.trim() : `${r.stdout}\n${r.stderr}`, r.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("music-convert", {
    description: "Convert sheet music (PDF/image/MusicXML) to ABC",
    handler: async (args, ctx) => {
      if (!args.trim()) return notify(ctx, "usage: /music-convert <file>", "warning");
      const r = await runCli(pi, ["convert", resolveFile(args.trim())]);
      notify(ctx, r.ok ? r.stdout.trim() : `${r.stdout}\n${r.stderr}`, r.ok ? "info" : "error");
    },
  });
}

function parseComposeArgs(args: string): { style?: string; refDir?: string; request: string } {
  const tokens = args.trim().split(/\s+/);
  let style: string | undefined;
  let refDir: string | undefined;
  const req: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--style" && tokens[i + 1]) {
      style = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--refs" && tokens[i + 1]) {
      refDir = tokens[i + 1];
      i++;
    } else {
      req.push(tokens[i]);
    }
  }
  return { style, refDir, request: req.join(" ").trim() };
}