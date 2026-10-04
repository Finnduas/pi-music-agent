// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Real-browser check of an HTML score viewer: renders, plays audio, stops, and
 * resets when the piece ends. Drives headless Chrome/Edge over the DevTools
 * protocol (no extra dependencies; needs Node 22+ for the built-in WebSocket).
 *
 * Needs an internet connection: abcjs loads its piano samples on first Play.
 *
 * Usage:
 *   npm run check:browser                         # default example
 *   node scripts/check-browser.mjs path/to/piece.html [--full]
 *     --full  also wait for the piece to finish and check the button resets
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const full = args.includes("--full");
const file = path.resolve(args.find((a) => !a.startsWith("--")) ?? "examples/output/minuet-with-gap-filled.html");
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) {
  console.error("No Chrome/Edge found. Set CHROME_PATH to your browser executable.");
  process.exit(1);
}

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "music-viewer-check-"));
const proc = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, pass, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed = true;
}

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("browser did not start");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const js = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }))
      .result?.result?.value;
  const ui = () =>
    js(`({ button: document.getElementById('btn-play').textContent,
           status: document.getElementById('status').textContent })`);

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: pathToFileURL(file).href });
  await sleep(2500);

  console.log(`Viewer: ${file}\nBrowser: ${browser}\n`);
  const page = await js(`({ svg: document.querySelectorAll('#paper svg').length,
                             notes: document.querySelectorAll('#paper .abcjs-note').length,
                             audio: !!(window.ABCJS && ABCJS.synth && ABCJS.synth.supportsAudio()) })`);
  check("score renders as sheet music", page?.svg > 0 && page?.notes > 0, `${page?.notes ?? 0} notes`);
  check("browser supports audio", page?.audio === true);

  const midi = await js(`new Promise(function (resolve) {
      var oc = URL.createObjectURL, click = HTMLAnchorElement.prototype.click, out = {};
      URL.createObjectURL = function (b) { out.bytes = b.size; out.type = b.type; return oc.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { out.name = this.download; };
      document.getElementById('btn-midi').click();
      URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = click;
      resolve(out);
    })`);
  check("Download MIDI produces a .mid file", midi?.type === "audio/midi" && midi?.bytes > 14, `${midi?.name}, ${midi?.bytes} bytes`);

  await js(`document.getElementById('btn-play').click()`);
  const t0 = Date.now();
  let s;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    s = await ui();
    if (!/Loading/.test(s.status)) break;
  }
  check("Play starts audio", /Stop/.test(s.button) && /Playing/.test(s.status), `${((Date.now() - t0) / 1000).toFixed(1)}s to load sounds; status "${s.status}"`);

  if (full) {
    let ended = false;
    for (let i = 0; i < 240 && !ended; i++) {
      await sleep(500);
      ended = /Play/.test((await ui()).button);
    }
    check("button resets to Play when the piece ends", ended);
  } else {
    await sleep(1500);
    await js(`document.getElementById('btn-play').click()`);
    await sleep(300);
    const after = await ui();
    check("Stop stops playback", /Play/.test(after.button) && after.status === "");
  }

  check("no JavaScript errors", errors.length === 0, errors.join("; "));
  ws.close();
} catch (e) {
  check("browser check ran", false, e?.message ?? String(e));
} finally {
  proc.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("\nViewer works in a real browser.");
process.exit(0);
