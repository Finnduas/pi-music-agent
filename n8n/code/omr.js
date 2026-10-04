// Sheet music -> ABC conversion for the "OMR Conversion Service" n8n workflow.
// POST { filename, mimeType, data(base64) } -> { abc, valid, errors[], warnings[] }.
// Uses Audiveris (OMR -> MusicXML) then music21 (MusicXML -> ABC). Best-effort:
// works for clean printed scores; handwritten/complex engraving is error-prone.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  return { valid: errors.length === 0, errors, warnings };
}

function run(cmd, args, opts) {
  try {
    return { ok: true, out: cp.execFileSync(cmd, args, { encoding: 'utf8', ...opts }) };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.message || String(e)).toString() };
  }
}

function findFile(dir, re) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { const hit = findFile(p, re); if (hit) return hit; }
    else if (re.test(name)) return p;
  }
  return null;
}

const items = $input.all();
const out = [];
for (const item of items) {
  const body = item.json.body || item.json;
  const warnings = [];
  const errors = [];
  let abc = '';
  try {
    const data = body.data || '';
    if (!data) throw new Error('Missing base64 "data" field.');
    const filename = body.filename || 'score';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-'));
    const input = path.join(workDir, filename);
    fs.writeFileSync(input, Buffer.from(data, 'base64'));
    const xmlDir = path.join(workDir, 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });

    const audiveris = process.env.AUDIVERIS || 'audiveris';
    const r1 = run(audiveris, ['-batch', '-export', '-output', xmlDir, input]);
    if (!r1.ok) { warnings.push('Audiveris: ' + r1.err); throw new Error('Audiveris step failed: ' + r1.err); }
    const musicXml = findFile(xmlDir, /\.(mxl|musicxml|xml)$/i);
    if (!musicXml) throw new Error('Audiveris produced no MusicXML output.');

    const python = process.env.MUSIC21_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const abcOut = path.join(workDir, 'score.abc');
    const py =
      'from music21 import converter\n' +
      "s = converter.parse(r'" + musicXml + "')\n" +
      "s.write('abc', fp=r'" + abcOut + "')";
    const r2 = run(python, ['-c', py]);
    if (!r2.ok) { warnings.push('music21: ' + r2.err); throw new Error('music21 step failed: ' + r2.err); }
    abc = fs.readFileSync(abcOut, 'utf8');
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (e) {
    errors.push(e.message || String(e));
  }
  const struct = structuralCheck(abc);
  out.push({ json: {
    abc,
    valid: errors.length === 0 && struct.valid,
    errors: [...errors, ...struct.errors],
    warnings: [...warnings, ...struct.warnings],
  }});
}
return out;
