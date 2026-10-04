// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
// Live check of the n8n integration (npm run check:n8n [-- --full]).
//
// Needs, running: `music-agent serve` (port 7878) and n8n (port 5678) with the workflows from
// ./n8n imported AND activated. Without them this prints what is missing and exits 2.
//   default : validation parity (n8n vs local) + API/webhook plumbing (no LLM, free, fast)
//   --full  : also composes a piece through the compose webhook (real LLM call)
import { createValidator } from "../dist/validate/validator.js";

const N8N = process.env.N8N_URL ?? "http://127.0.0.1:5678";
const API = process.env.MUSIC_API_URL ?? "http://127.0.0.1:7878";
const full = process.argv.includes("--full");

let failed = false;
const check = (name, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !extra ? "" : "  -> " + extra}`);
  if (!pass) failed = true;
};
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/* ---- are both services up? ---- */
const up = async (url) => fetch(url).then((r) => r.ok).catch(() => false);
const apiUp = await up(`${API}/health`);
const n8nUp = await up(`${N8N}/healthz`);
if (!apiUp || !n8nUp) {
  if (!apiUp) console.log(`music-agent API not reachable at ${API}  (start it: npm run serve)`);
  if (!n8nUp) console.log(`n8n not reachable at ${N8N}  (see n8n/README.md)`);
  process.exit(2);
}

/* ---- validation workflow gives the same verdicts as the local validator ---- */
const local = createValidator({ backend: "local", n8n: { webhookUrl: "", timeoutMs: 1000 } });
const viaN8n = createValidator({ backend: "n8n", n8n: { webhookUrl: `${N8N}/webhook/notation-validation`, timeoutMs: 30000 } });
const samples = {
  "complete piece ending in |]": "X:1\nT:t\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |]\n",
  "missing X: and K:": "M:4/4\nL:1/4\nC D E F |\n",
  "unclosed chord bracket": "X:1\nM:4/4\nL:1/4\nK:C\nC D [E F |\n",
  "empty": "",
};
for (const [label, notation] of Object.entries(samples)) {
  const a = await local.validate({ notation });
  const b = await viaN8n.validate({ notation });
  check(`validation parity: ${label} (valid=${a.valid})`, a.valid === b.valid && b.backend === "n8n", JSON.stringify(b));
}

/* ---- compose webhook: input errors come back as a clean JSON error ---- */
const bad = await post(`${N8N}/webhook/compose-piece`, { style: "baroque" });
check("compose webhook: missing request -> 400 with a clean message", bad.status === 400 && /request/.test(String(bad.json.error)), JSON.stringify(bad.json).slice(0, 200));

/* ---- the API the workflows call ---- */
const an = await post(`${API}/analyze`, { abc: "X:1\nM:3/4\nL:1/4\nK:G\nG B d | z3 |]\n" });
check("api analyze finds the empty bar", an.status === 200 && an.json.gaps?.length === 1, JSON.stringify(an.json));
const esc = await post(`${API}/analyze`, { file: "../../Windows/win.ini" });
check("api refuses paths outside the project", esc.status === 400, JSON.stringify(esc.json));

if (full) {
  const t0 = Date.now();
  const r = await post(`${N8N}/webhook/compose-piece`, { request: "a very short 4-bar tune in C major", style: "classical", title: "n8n check" });
  check(`compose webhook composes a piece (${((Date.now() - t0) / 1000).toFixed(0)}s)`, r.status === 200 && /^X:/m.test(r.json.abc ?? "") && Array.isArray(r.json.files), JSON.stringify(r.json).slice(0, 200));
} else {
  console.log("skip  compose through the webhook (real LLM call); use --full");
}

console.log(failed ? "\nSome n8n checks FAILED." : "\nn8n integration works.");
process.exit(failed ? 1 : 0);
