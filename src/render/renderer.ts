/** Render ABC -> SVG/PDF (abc2svg/abcm2ps CLI) and a self-contained abcjs HTML viewer. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

/** Best-effort: copy abcjs's browser bundle next to the viewer for offline use. */
async function vendorAbcjs(outDir: string): Promise<string | null> {
  try {
    const src = require.resolve("abcjs/dist/abcjs-basic-min.js");
    const dest = path.join(outDir, "abcjs-basic-min.js");
    await fs.mkdir(outDir, { recursive: true });
    await fs.copyFile(src, dest);
    return "./abcjs-basic-min.js";
  } catch {
    return null;
  }
}

export interface RenderOptions {
  abc: string;
  outDir: string;
  baseName: string; // without extension
  prefer: string[]; // e.g. ["abc2svg", "abcm2ps"]
  formats: string[]; // "svg" | "html" | "pdf" | "midi"
  abc2svgPath: string;
  abcm2psPath: string;
}

export interface RenderResult {
  files: string[]; // absolute paths written
  engine: string; // which engine produced the SVG (or "abcjs" for the viewer)
  warnings: string[];
}

async function which(bin: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      await exec("where", [bin]);
    } else {
      await exec("command", ["-v", bin]);
    }
    return bin;
  } catch {
    return null;
  }
}

async function writeFile(p: string, data: string | Buffer): Promise<string> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  return p;
}

/* --------------------------- CLI engine helpers -------------------------- */

async function renderWithAbc2svg(
  opts: RenderOptions,
  bin: string,
  abcPath: string,
  svgPath: string,
): Promise<string | null> {
  try {
    // abc2svg reads a file and writes SVG to stdout.
    const { stdout } = await exec(bin, [abcPath], { maxBuffer: 64 * 1024 * 1024 });
    if (!stdout.includes("<svg")) return null;
    await writeFile(svgPath, stdout);
    return bin;
  } catch {
    return null;
  }
}

async function renderWithAbcm2ps(
  opts: RenderOptions,
  bin: string,
  abcPath: string,
  svgPath: string,
): Promise<string | null> {
  try {
    // abcm2ps -g (SVG) -O out.abc -  -> writes out001.svg etc.
    const stem = svgPath.replace(/\.svg$/, "");
    await exec(bin, ["-g", "-O", stem + ".abc", abcPath]);
    // abcm2ps may emit numerical suffixes; normalise.
    const dir = path.dirname(svgPath);
    const base = path.basename(stem);
    const entries = await fs.readdir(dir);
    const produced = entries.filter((f) => f.startsWith(base) && f.endsWith(".svg")).sort();
    if (!produced.length) return null;
    const buf = await fs.readFile(path.join(dir, produced[0]));
    await writeFile(svgPath, buf);
    for (const f of produced) {
      if (path.join(dir, f) !== svgPath) await fs.rm(path.join(dir, f), { force: true });
    }
    return bin;
  } catch {
    return null;
  }
}

/* ----------------------------- abcjs viewer ------------------------------ */

function htmlViewer(title: string, abc: string, scriptSrc: string): string {
  const safeTitle = title.replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
  );
  const abcJson = JSON.stringify(abc);
  const fallback = "https://cdn.jsdelivr.net/npm/abcjs@6/dist/abcjs-basic-min.js";
  const onerror =
    scriptSrc === fallback
      ? ""
      : ` onerror="this.onerror=null;this.src='${fallback}'"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<script src="${scriptSrc}"${onerror}></script>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; font-weight: 600; }
  #paper { background: #fff; }
  pre { background: #f5f5f5; padding: 1rem; overflow:auto; border-radius: 6px; font-size: .8rem; }
  .controls { margin: 1rem 0; display:flex; gap:.5rem; flex-wrap:wrap; }
  button { padding:.4rem .8rem; border:1px solid #ccc; background:#fff; border-radius:6px; cursor:pointer; }
  button:hover { background:#f0f0f0; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<div id="paper"></div>
<div class="controls">
  <button onclick="toggleAbc()">Show/hide ABC</button>
  <button onclick="stopAudio && stopAudio()">Stop audio</button>
</div>
<pre id="abc" hidden></pre>
<script>
  var abc = ${abcJson};
  document.getElementById('abc').textContent = abc;
  var renderer = new ABCJS.Editor('paper', { canvas_id: 'paper' }, {});
  ABCJS.renderAbc('paper', abc, { responsive: 'resize' });
  var synth = new ABCJS.synth.CreateSynth();
  function toggleAbc(){ var e=document.getElementById('abc'); e.hidden=!e.hidden; }
  var stopAudio = null;
  // Optional: play button could be added here via ABCJS.synth.
</script>
</body>
</html>`;
}

/* ------------------------------ public API ------------------------------- */

export async function renderAbc(opts: RenderOptions): Promise<RenderResult> {
  const warnings: string[] = [];
  const files: string[] = [];
  const abcPath = path.join(opts.outDir, `${opts.baseName}.abc`);
  await writeFile(abcPath, opts.abc);
  files.push(abcPath);

  let engine = "none";
  const svgPath = path.join(opts.outDir, `${opts.baseName}.svg`);
  const wantSvg = opts.formats.includes("svg");

  if (wantSvg) {
    for (const pref of opts.prefer) {
      if (pref === "abc2svg") {
        const bin = await which(opts.abc2svgPath);
        if (!bin) continue;
        const used = await renderWithAbc2svg(opts, bin, abcPath, svgPath);
        if (used) { engine = used; files.push(svgPath); break; }
      } else if (pref === "abcm2ps") {
        const bin = await which(opts.abcm2psPath);
        if (!bin) continue;
        const used = await renderWithAbcm2ps(opts, bin, abcPath, svgPath);
        if (used) { engine = used; files.push(svgPath); break; }
      }
    }
    if (engine === "none") {
      warnings.push(
        "No SVG engine found (abc2svg/abcm2ps not installed); wrote HTML viewer only.",
      );
    }
  }

  if (opts.formats.includes("html")) {
    const vendor = await vendorAbcjs(opts.outDir);
    const htmlPath = path.join(opts.outDir, `${opts.baseName}.html`);
    await writeFile(
      htmlPath,
      htmlViewer(opts.baseName, opts.abc, vendor ?? "https://cdn.jsdelivr.net/npm/abcjs@6/dist/abcjs-basic-min.js"),
    );
    files.push(htmlPath);
    if (engine === "none") engine = "abcjs";
  }

  return { files, engine, warnings };
}
