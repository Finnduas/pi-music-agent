// ABC validation for the "Notation Validation Service" n8n workflow.
// Mirrors the local validator (src/validate/validator.ts): abcjs parseOnly (headless, no DOM),
// plus the required X:/K: headers. No LLM, no loop, no storage.
// Needs: NODE_FUNCTION_ALLOW_EXTERNAL=abcjs on the n8n instance and `abcjs` installed next to n8n.
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function validate(notation) {
  const errors = [];
  const warnings = [];
  if (!notation || typeof notation !== 'string' || notation.trim() === '') {
    return { valid: false, errors: ['Empty notation.'], warnings };
  }

  let tunes = null;
  try {
    const abcjs = require('abcjs');
    tunes = abcjs.parseOnly(notation);
  } catch (e) {
    warnings.push('abcjs unavailable in n8n (install it and set NODE_FUNCTION_ALLOW_EXTERNAL=abcjs); header checks only: ' + (e.message || e));
  }

  if (tunes) {
    if (!Array.isArray(tunes) || tunes.length === 0) errors.push('No tunes found in notation.');
    let staves = 0;
    for (const t of tunes || []) {
      for (const w of t.warnings || []) warnings.push(stripTags(w));
      staves += (t.lines || []).reduce((n, l) => n + (l.staff || []).length, 0);
    }
    if (tunes.length && staves === 0) errors.push('No staff content parsed (nothing to engrave).');
  }

  if (!/^\s*X\s*:/m.test(notation)) errors.push('Missing required X: (tune number) header.');
  if (!/^\s*K\s*:/m.test(notation)) errors.push('Missing required K: (key) header.');
  if (!/^\s*M\s*:/m.test(notation) && !/\[M:/.test(notation)) warnings.push('No M: (meter) header; defaulting to 4/4.');
  if (!/^\s*L\s*:/m.test(notation) && !/\[L:/.test(notation)) warnings.push('No L: (default note length) header.');
  return { valid: errors.length === 0, errors, warnings };
}

return $input.all().map((item) => {
  const body = item.json.body || item.json;
  return { json: validate(body.notation || '') };
});
