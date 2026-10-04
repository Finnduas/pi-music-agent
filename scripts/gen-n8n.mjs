// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
// Generates the importable n8n workflows in ./n8n/ (npm run gen:n8n).
//
//   validation.json       agent -> n8n   ABC validation service      (webhook /notation-validation)
//   omr-conversion.json   agent -> n8n   sheet music -> ABC (OMR)    (webhook /omr-conversion)
//   inbox.json            n8n -> agent   watch .input, convert, fill gaps
//   compose-webhook.json  n8n -> agent   POST /webhook/compose-piece -> a composed piece
//
// The two "n8n -> agent" workflows call the local API started by `music-agent serve`.
import fs from "node:fs";
import path from "node:path";

const API = "http://127.0.0.1:7878";
const codeOf = (f) => fs.readFileSync(path.join("n8n", "code", f), "utf8");

/* ----------------------------- node builders ----------------------------- */
let seq = 0;
const id = () => `n${String(++seq).padStart(2, "0")}`;

const webhook = (name, pathName, position) => ({
  parameters: { httpMethod: "POST", path: pathName, responseMode: "responseNode", options: {} },
  id: id(),
  name,
  type: "n8n-nodes-base.webhook",
  typeVersion: 2,
  position,
  webhookId: pathName,
});

const code = (name, jsCode, position) => ({
  parameters: { mode: "runOnceForAllItems", jsCode },
  id: id(),
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position,
});

const respond = (name, position, codeExpr) => ({
  parameters: {
    respondWith: "json",
    responseBody: "={{ $json }}",
    options: codeExpr ? { responseCode: codeExpr } : {},
  },
  id: id(),
  name,
  type: "n8n-nodes-base.respondToWebhook",
  typeVersion: 1,
  position,
});

/** POST JSON to the music-agent API; `body` is a JS expression producing the object. */
const api = (name, route, body, position, timeoutMs = 600000) => ({
  parameters: {
    method: "POST",
    url: `${API}${route}`,
    sendBody: true,
    specifyBody: "json",
    jsonBody: `={{ JSON.stringify(${body}) }}`,
    // neverError: a 4xx from the API (e.g. missing field) becomes a normal { error } item, not a stack trace
    options: { timeout: timeoutMs, response: { response: { neverError: true } } },
  },
  id: id(),
  name,
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position,
  onError: "continueRegularOutput", // HTTP errors become { error } items instead of aborting
});

const ifNode = (name, leftExpr, operator, rightValue, type, position) => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
      conditions: [{ id: id(), leftValue: leftExpr, rightValue, operator: { type, operation: operator } }],
      combinator: "and",
    },
    options: {},
  },
  id: id(),
  name,
  type: "n8n-nodes-base.if",
  typeVersion: 2,
  position,
});

const setFields = (name, fields, position) => ({
  parameters: {
    assignments: {
      assignments: fields.map(([n, v]) => ({ id: id(), name: n, value: v, type: "string" })),
    },
    options: {},
  },
  id: id(),
  name,
  type: "n8n-nodes-base.set",
  typeVersion: 3.4,
  position,
});

const link = (to, index = 0) => ({ node: to, type: "main", index });
let wfSeq = 0;
const workflow = (name, description, nodes, connections) => ({
  // id / versionId / active make the file importable with `n8n import:workflow` as well as via the UI
  id: `pimusic${++wfSeq}`,
  versionId: `00000000-0000-4000-8000-00000000000${wfSeq}`,
  active: false,
  name,
  nodes,
  connections,
  settings: { executionOrder: "v1" },
  pinData: {},
  meta: { instanceId: "pi-music-agent", description },
  tags: [{ id: "pimusictag0001", name: "pi-music-agent" }],
});

/* ------------------------------- workflows ------------------------------- */
const out = {};

// 1) validation (agent -> n8n)
out["validation.json"] = workflow(
  "Notation Validation Service",
  "Validation-only service. POST { notation } -> { valid, errors[], warnings[] }. Used by `validation.backend: n8n`.",
  [
    webhook("Webhook", "notation-validation", [220, 300]),
    code("Validate ABC", codeOf("validate.js"), [460, 300]),
    respond("Respond", [700, 300]),
  ],
  {
    Webhook: { main: [[link("Validate ABC")]] },
    "Validate ABC": { main: [[link("Respond")]] },
  },
);

// 2) OMR conversion (agent -> n8n)
out["omr-conversion.json"] = workflow(
  "OMR Conversion Service",
  "Sheet music -> ABC. POST { filename, mimeType, data(base64) } -> { abc, valid, errors[], warnings[] }. Used by `conversion.backend: n8n`.",
  [
    webhook("Webhook", "omr-conversion", [220, 300]),
    code("Convert sheet music to ABC", codeOf("omr.js"), [480, 300]),
    respond("Respond", [740, 300]),
  ],
  {
    Webhook: { main: [[link("Convert sheet music to ABC")]] },
    "Convert sheet music to ABC": { main: [[link("Respond")]] },
  },
);

// 3) inbox (n8n -> agent): .input -> convert -> analyze -> fill gaps
const classify = String.raw`// Decide what to do with a new file in .input. Anything else is ignored.
const SCAN = /\.(pdf|png|jpe?g|tiff?|bmp|gif|musicxml|xml|mxl)$/i;
const out = [];
for (const item of $input.all()) {
  const file = String(item.json.path || '');
  const kind = /\.abc$/i.test(file) ? 'abc' : SCAN.test(file) ? 'scan' : 'ignore';
  if (kind !== 'ignore') out.push({ json: { file, kind } });
}
return out;`;

out["inbox.json"] = workflow(
  "Sheet Music Inbox",
  "Drop a file in .input: scans are converted to ABC, gaps are found and filled, a viewer is rendered into .output. Needs `music-agent serve`.",
  [
    {
      parameters: {
        triggerOn: "folder",
        path: "./.input",
        events: ["add"],
        options: { awaitWriteFinish: true },
      },
      id: id(),
      name: "New file in .input",
      type: "n8n-nodes-base.localFileTrigger",
      typeVersion: 1,
      position: [200, 300],
    },
    code("Classify file", classify, [420, 300]),
    ifNode("Is it a scan?", "={{ $json.kind }}", "equals", "scan", "string", [640, 300]),
    api("Convert scan to ABC", "/convert", "{ file: $json.file }", [860, 180]),
    ifNode("Converted?", "={{ $json.valid }}", "true", "", "boolean", [1080, 180]),
    setFields(
      "Conversion failed",
      [
        ["status", "conversion failed"],
        ["details", "={{ ($json.errors || [$json.error && ($json.error.message || $json.error)]).join('; ') }}"],
      ],
      [1300, 280],
    ),
    api("Analyze", "/analyze", "{ file: $json.file }", [1300, 80]),
    ifNode("Has gaps?", "={{ $json.gaps.length }}", "gt", 0, "number", [1520, 80]),
    api(
      "Fill the gaps",
      "/edit",
      "{ file: $json.file, instruction: 'fill in the gap in ' + $json.gaps.join('; ') }",
      [1740, 0],
    ),
    setFields(
      "Report: gaps filled",
      [
        ["status", "={{ $json.error ? 'edit failed' : 'gaps filled' }}"],
        ["title", "={{ $json.title }}"],
        ["critic score", "={{ $json.score }}"],
        ["files", "={{ ($json.files || []).join(', ') }}"],
        ["details", "={{ $json.error || $json.summary }}"],
      ],
      [1960, 0],
    ),
    setFields(
      "Report: nothing to do",
      [
        ["status", "no gaps found"],
        ["file", "={{ $json.file }}"],
        ["details", "={{ $json.bars }} bars, key {{ $json.key }}, meter {{ $json.meter }}" ],
      ],
      [1740, 160],
    ),
  ],
  {
    "New file in .input": { main: [[link("Classify file")]] },
    "Classify file": { main: [[link("Is it a scan?")]] },
    "Is it a scan?": { main: [[link("Convert scan to ABC")], [link("Analyze")]] },
    "Convert scan to ABC": { main: [[link("Converted?")]] },
    "Converted?": { main: [[link("Analyze")], [link("Conversion failed")]] },
    Analyze: { main: [[link("Has gaps?")]] },
    "Has gaps?": { main: [[link("Fill the gaps")], [link("Report: nothing to do")]] },
    "Fill the gaps": { main: [[link("Report: gaps filled")]] },
  },
);

// 4) compose webhook (n8n -> agent)
out["compose-webhook.json"] = workflow(
  "Compose a Piece (webhook)",
  "POST /webhook/compose-piece { request, style?, title?, refs? } -> the composed piece (abc, score, files). Needs `music-agent serve`.",
  [
    webhook("Webhook", "compose-piece", [220, 300]),
    api(
      "Compose",
      "/compose",
      "{ request: $json.body.request, style: $json.body.style, title: $json.body.title, refs: $json.body.refs }",
      [460, 300],
    ),
    respond("Respond", [700, 300], "={{ $json.error ? 400 : 200 }}"),
  ],
  {
    Webhook: { main: [[link("Compose")]] },
    Compose: { main: [[link("Respond")]] },
  },
);

/* --------------------------------- write --------------------------------- */
fs.mkdirSync("n8n", { recursive: true });
for (const [file, wf] of Object.entries(out)) {
  fs.writeFileSync(path.join("n8n", file), JSON.stringify(wf, null, 2) + "\n");
  console.log("wrote n8n/" + file);
}
