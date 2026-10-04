// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for the renderer: HTML viewer contents and explicit
 * warnings for unsupported output formats.
 * Run: npx tsx scripts/smoke-render.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderAbc } from "../src/render/renderer.js";

const ABC = `X:1
T:Render Test
M:3/4
L:1/8
K:D
D E F G | A2 B2 c2 | d6 |]`;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-render-"));

  // HTML viewer is produced even with no SVG engine installed.
  const html = await renderAbc({
    abc: ABC,
    outDir: dir,
    baseName: "render-test",
    prefer: [],
    formats: ["html"],
    abc2svgPath: "abc2svg",
    abcm2psPath: "abcm2ps",
  });
  const htmlPath = path.join(dir, "render-test.html");
  const page = await fs.readFile(htmlPath, "utf8");

  // Unsupported formats must raise warnings, not be silently dropped.
  const warn = await renderAbc({
    abc: ABC,
    outDir: dir,
    baseName: "render-warn",
    prefer: [],
    formats: ["html", "pdf", "midi", "bogus"],
    abc2svgPath: "abc2svg",
    abcm2psPath: "abcm2ps",
  });

  const checks: [string, boolean][] = [
    ["html viewer written", html.files.includes(htmlPath)],
    ["abc source written", await exists(path.join(dir, "render-test.abc"))],
    ["abcjs bundle vendored", await exists(path.join(dir, "abcjs-basic-min.js"))],
    ["viewer has Print / Save PDF control", page.includes("Print / Save PDF")],
    ["viewer has Download .abc control", page.includes("Download .abc")],
    ["viewer no longer instantiates ABCJS.Editor", !page.includes("ABCJS.Editor")],
    ["viewer no longer has dead Stop audio stub", !page.includes("Stop audio")],
    ["viewer has Play control", page.includes('id="btn-play"')],
    ["viewer plays via the abcjs synth", page.includes("ABCJS.synth.CreateSynth")],
    ["viewer has Download MIDI control", page.includes("Download MIDI")],
    ["viewer keeps the rendered tune for playback", page.includes("tune = ABCJS.renderAbc(")],
    [
      "pdf format warns (use viewer print)",
      warn.warnings.some((w) => w.includes("Print / Save PDF")),
    ],
    [
      "midi format warns (points to viewer Play / Download MIDI)",
      warn.warnings.some((w) => w.includes("Download MIDI")),
    ],
    ["unknown format warns", warn.warnings.some((w) => w.includes("bogus"))],
  ];

  console.log("\n--- render checks ---");
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }

  await fs.rm(dir, { recursive: true, force: true });
  if (!ok) process.exit(1);
  console.log("\nAll render smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});