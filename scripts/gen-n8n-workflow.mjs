// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
// Generates src/validate/n8n-workflow.json with a correctly-escaped Code node.
import fs from "node:fs";
import path from "node:path";

const code = String.raw`// ABC validation for the "Notation Validation Service" n8n workflow.
// Uses abcjs from the Code node sandbox when available; otherwise falls back to
// structural checks. No LLM, no loop, no storage.
const items = $input.all();
const out = [];

function structuralCheck(notation) {
  const errors = [];
  const warnings = [];
  if (!notation || typeof notation !== 'string' || notation.trim() === '') {
    errors.push('Empty notation.');
    return { valid: false, errors, warnings };
  }
  if (!/^\s*X\s*:/m.test(notation)) errors.push('Missing required X: header.');
  if (!/^\s*K\s*:/m.test(notation)) errors.push('Missing required K: header.');
  if (!/^\s*M\s*:/m.test(notation) && !/\[M:/.test(notation)) warnings.push('No M: meter header.');
  if (!/^\s*L\s*:/m.test(notation) && !/\[L:/.test(notation)) warnings.push('No L: default note length header.');
  const opens = (notation.match(/\[/g) || []).length;
  const closes = (notation.match(/\]/g) || []).length;
  if (opens !== closes) errors.push('Unbalanced [ ] brackets (likely truncated).');
  const pops = (notation.match(/\(/g) || []).length;
  const pcloses = (notation.match(/\)/g) || []).length;
  if (pops !== pcloses) errors.push('Unbalanced ( ) parentheses.');
  return { valid: errors.length === 0, errors, warnings };
}

for (const item of items) {
  const body = item.json.body || item.json;
  const notation = body.notation || '';
  let result;
  try {
    const abcjs = require('abcjs');
    const tunes = abcjs.renderAbc('*', notation, { add_classes: false });
    const errors = [];
    const warnings = [];
    if (!Array.isArray(tunes) || tunes.length === 0) errors.push('No tunes found.');
    for (const t of tunes || []) {
      for (const w of t.warnings || []) warnings.push(String(w));
      const hasStaff = (t.lines || []).some((l) => (l.staff || []).length > 0);
      if (!hasStaff) errors.push('Tune produced no staff content.');
    }
    const struct = structuralCheck(notation);
    result = {
      valid: errors.length === 0 && struct.valid,
      errors: [...errors, ...struct.errors],
      warnings: [...warnings, ...struct.warnings],
    };
  } catch (e) {
    result = structuralCheck(notation);
    result.warnings.push('abcjs unavailable; used structural checks only: ' + (e.message || e));
  }
  out.push({ json: result });
}
return out;
`;

const workflow = {
  name: "Notation Validation Service",
  nodes: [
    {
      parameters: {
        httpMethod: "POST",
        path: "notation-validation",
        responseMode: "responseNode",
        options: {},
      },
      id: "webhook-1",
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [220, 300],
      webhookId: "notation-validation",
    },
    {
      parameters: { mode: "runOnceForAllItems", jsCode: code },
      id: "validate-1",
      name: "Validate ABC",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [460, 300],
    },
    {
      parameters: { respondWith: "json", responseBody: "={{ $json }}", options: {} },
      id: "respond-1",
      name: "Respond",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1,
      position: [700, 300],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Validate ABC", type: "main", index: 0 }]] },
    "Validate ABC": { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
  pinData: {},
  meta: {
    instanceId: "pi-music-agent-validation",
    description:
      "Validation-only service. POST { notation, title?, style? } -> { valid, errors[], warnings[] }. No LLM, no loop, no storage.",
  },
  tags: [{ name: "pi-music-agent" }],
};

const outPath = path.resolve("src/validate/n8n-workflow.json");
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2) + "\n");
console.log("wrote", outPath);
