// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
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
  const safeTitle = title.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  const abcJson = JSON.stringify(abc);
  const downloadName = JSON.stringify(`${title}.abc`);
  const fallback = "https://cdn.jsdelivr.net/npm/abcjs@6/dist/abcjs-basic-min.js";
  const onerror =
    scriptSrc === fallback
      ? ""
      : ` onerror="if(this.src!=='${fallback}'){this.onerror=null;this.src='${fallback}'}"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<script src="${scriptSrc}"${onerror}></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 1rem; }
  #paper { background: #fff; overflow-x: auto; }
  pre { background: #f5f5f5; padding: 1rem; overflow: auto; border-radius: 6px; font-size: .8rem; white-space: pre-wrap; }
  .controls { margin: 1rem 0; display: flex; gap: .5rem; flex-wrap: wrap; }
  button { padding: .45rem .9rem; border: 1px solid #c9c9c9; background: #fff; border-radius: 6px; cursor: pointer; font-size: .9rem; }
  button:hover { background: #f0f0f0; }
  #fallback { color: #a00; }
  #status { font-size: .85rem; color: #666; min-height: 1.2em; }
  @media print {
    body { margin: 0; max-width: none; padding: 0; }
    h1 { margin: 0 0 1rem; }
    .controls, #abc, #fallback, #status { display: none !important; }
    #paper { background: #fff; }
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #111; }
    #paper { background: #fff; padding: 1rem; border-radius: 6px; }
    pre { background: #1f1f1f; color: #e6e6e6; }
  }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<div id="fallback" hidden></div>
<div id="paper"></div>
<div class="controls">
  <button type="button" id="btn-play">&#9654; Play</button>
  <button type="button" id="btn-midi">Download MIDI</button>
  <button type="button" id="btn-abc">Show ABC</button>
  <button type="button" id="btn-download">Download .abc</button>
  <button type="button" id="btn-print">Print / Save PDF</button>
</div>
<div id="status" aria-live="polite"></div>
<pre id="abc" hidden></pre>
<script>
(function () {
  var abc = ${abcJson};
  var downloadName = ${downloadName};
  var paper = document.getElementById('paper');
  var abcEl = document.getElementById('abc');
  var fallback = document.getElementById('fallback');
  abcEl.textContent = abc;

  function toggleAbc() {
    var hidden = !abcEl.hidden;
    abcEl.hidden = hidden;
    document.getElementById('btn-abc').textContent = hidden ? 'Show ABC' : 'Hide ABC';
  }

  function downloadAbc() {
    var blob = new Blob([abc], { type: 'text/vnd.abc' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function printPage() { window.print(); }

  /* ---- audio: abcjs synth (piano samples load from the internet on first play) ---- */
  var tune = null;
  var synth = null;
  var playing = false;
  var btnPlay = document.getElementById('btn-play');
  var statusEl = document.getElementById('status');
  function setStatus(msg) { statusEl.textContent = msg || ''; }

  function stopPlayback() {
    if (synth) { try { synth.stop(); } catch (e) {} }
    playing = false;
    btnPlay.innerHTML = '&#9654; Play';
  }

  function togglePlay() {
    if (playing) { stopPlayback(); setStatus(''); return; }
    if (!tune || !ABCJS.synth || !ABCJS.synth.supportsAudio()) {
      setStatus('Audio playback is not supported in this browser. Use Download MIDI instead.');
      return;
    }
    btnPlay.disabled = true;
    setStatus('Loading piano sounds...');
    synth = new ABCJS.synth.CreateSynth();
    synth.init({ visualObj: tune, options: { onEnded: function () { stopPlayback(); setStatus(''); } } })
      .then(function () { return synth.prime(); })
      .then(function () {
        synth.start();
        playing = true;
        btnPlay.innerHTML = '&#9632; Stop';
        setStatus('Playing...');
      })
      .catch(function (e) {
        stopPlayback();
        setStatus('Could not play audio (the piano sounds need an internet connection on first play). ' +
          'Use Download MIDI instead. ' + (e && e.message ? e.message : ''));
      })
      .then(function () { btnPlay.disabled = false; });
  }

  function downloadMidi() {
    try {
      var bytes = ABCJS.synth.getMidiFile(abc, { midiOutputType: 'binary' })[0];
      var url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = downloadName.replace(/\\.abc$/, '') + '.mid';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (e) {
      setStatus('Could not create MIDI: ' + (e && e.message ? e.message : e));
    }
  }

  document.getElementById('btn-abc').addEventListener('click', toggleAbc);
  document.getElementById('btn-download').addEventListener('click', downloadAbc);
  document.getElementById('btn-print').addEventListener('click', printPage);
  btnPlay.addEventListener('click', togglePlay);
  document.getElementById('btn-midi').addEventListener('click', downloadMidi);

  if (typeof ABCJS !== 'undefined' && ABCJS.renderAbc) {
    tune = ABCJS.renderAbc(paper, abc, { responsive: 'resize', add_classes: true })[0] || null;
  } else {
    fallback.hidden = false;
    fallback.innerHTML = 'Could not load the ABCJS renderer &#8212; please check your network connection and reload.';
  }
})();
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

  // Surface unsupported formats instead of silently ignoring them.
  for (const fmt of opts.formats) {
    if (fmt === "svg" || fmt === "html") continue;
    if (fmt === "pdf") {
      warnings.push(
        'The CLI renderer does not emit PDF; open the HTML viewer and use "Print / Save PDF".',
      );
    } else if (fmt === "midi") {
      warnings.push(
        'The CLI does not write MIDI files; open the HTML viewer and use "Play" or "Download MIDI".',
      );
    } else {
      warnings.push(`Unknown render format "${fmt}" ignored (supported: svg, html).`);
    }
  }

  return { files, engine, warnings };
}
