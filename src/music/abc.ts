// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Deterministic ABC helpers: header/meter/voice/key analysis and transposition. */

export interface Meter {
  num: number;
  den: number;
  raw: string;
}

export interface Tonic {
  name: string;
  pc: number; // pitch class 0..11 (C=0)
  minor: boolean;
}

export interface ScoreAnalysis {
  bars: number;
  meter: string;
  key: string;
  tonic: string;
  minor: boolean;
  voices: string[];
  voiceCount: number;
  endsOnTonic: boolean | null;
  /** Candidate gaps: rest-only bars or bars annotated "GAP"/"?" (hints, not truth). */
  gaps: string[];
}

const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** A single note atom: accidental + letter + octave markers + duration. */
const NOTE_RE = /([=_^]{0,2})([a-gA-G])([',]*)([0-9]*\/?[0-9]*)/g;

export interface Headers {
  x?: string;
  t?: string;
  c?: string;
  m?: string;
  l?: string;
  q?: string;
  k?: string;
}

export function parseHeaders(abc: string): Headers {
  const h: Headers = {};
  for (const line of abc.split(/\r?\n/)) {
    const m = /^([A-Za-z]):\s*(.*?)\s*$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (["x", "t", "c", "m", "l", "q", "k"].includes(key) && !(key in h)) {
      (h as Record<string, string>)[key] = m[2];
    }
  }
  return h;
}

/** The tune body — everything after the first K: header line. */
export function bodyOf(abc: string): string {
  const lines = abc.split(/\r?\n/);
  let sawK = false;
  const body: string[] = [];
  for (const line of lines) {
    if (!sawK && /^\s*K\s*:/i.test(line.trim())) {
      sawK = true;
      continue;
    }
    if (sawK) body.push(line);
  }
  return body.join("\n");
}

export function meterOf(abc: string): Meter {
  const raw = parseHeaders(abc).m ?? "4/4";
  const m = /(\d+)\s*\/\s*(\d+)/.exec(raw);
  if (m) return { num: Number(m[1]), den: Number(m[2]), raw };
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return { num: n, den: 4, raw };
  return { num: 4, den: 4, raw: "4/4" };
}

export function voicesOf(abc: string): string[] {
  const ids: string[] = [];
  for (const line of abc.split(/\r?\n/)) {
    const m = /^\s*V\s*:\s*([^\s]+)/i.exec(line.trim());
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids.length ? ids : ["default"];
}

function accidentalSemitones(acc: string): number {
  let n = 0;
  for (const c of acc) n += c === "^" ? 1 : c === "_" ? -1 : 0;
  return n;
}

function pitchClassOf(acc: string, letter: string): number {
  const base = NATURAL_PC[letter.toUpperCase()] ?? 0;
  return (((base + accidentalSemitones(acc)) % 12) + 12) % 12;
}

export function tonicOf(key: string | undefined): Tonic {
  const k = (key ?? "C").trim();
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(k);
  if (!m) return { name: "C", pc: 0, minor: false };
  const letter = m[1].toUpperCase();
  const accidental = m[2];
  const rest = m[3].toLowerCase();
  const pc = pitchClassOf(accidental === "#" ? "^" : accidental === "b" ? "_" : "", letter);
  const minor = /m|min|dor|aeo|loc|phr/.test(rest);
  const name = letter + (accidental === "#" ? "#" : accidental === "b" ? "b" : "");
  return { name, pc, minor };
}

/** Approximate count of written measures (barlines + leading bar, best-effort). */
export function countBars(abc: string): number {
  const cleaned = bodyOf(abc)
    .replace(/\[[^\]]*\]/g, "") // drop chord/directive groups
    .replace(/\{[^}]*\}/g, "") // drop grace notes
    .replace(/"[^"]*"/g, "") // drop text annotations
    .replace(/%[^\n]*/g, ""); // drop comments
  const normalized = cleaned
    .replace(/\|\||\[\||\|\]|\|:/g, "|")
    .replace(/:\|/g, "|")
    .replace(/\|+/g, "|");
  const bars = (normalized.match(/\|/g) ?? []).length;
  // A bar line closes a measure; the tune opening bar is implied.
  return Math.max(0, bars);
}

function lastNotePc(abc: string): number | null {
  const body = bodyOf(abc)
    .replace(/"[^"]*"/g, "")
    .replace(/%[^\n]*/g, "");
  let last: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(w|s)\s*:/i.test(line)) continue; // lyrics / symbol lines
    for (const m of line.matchAll(new RegExp(NOTE_RE.source, "g"))) {
      const acc = m[1] ?? "";
      const letter = m[2] ?? m[0];
      if (!/[a-gA-G]/.test(letter)) continue;
      last = pitchClassOf(acc === "=" ? "" : acc, letter);
    }
  }
  return last;
}

/**
 * Find candidate "gaps": bars that contain only rests, or carry a "GAP" / "?"
 * text annotation (e.g. `"^GAP" z4`). Returned as human-readable ranges per
 * voice, e.g. "RH bars 5-6". Deterministic hint; the user's request decides.
 */
export interface BarInfo {
  voice: string;
  /** 1-based bar number within the voice. */
  n: number;
  text: string;
  /** Rest-only bar, or annotated "GAP"/"?". */
  gap: boolean;
}

/** Split the tune body into bars, per voice (shared by gap detection and the edit guard). */
export function barsOf(abc: string): BarInfo[] {
  const out: BarInfo[] = [];
  let voice = "default";
  const barNo: Record<string, number> = {};
  for (const raw of bodyOf(abc).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("%")) continue;
    const v = /^V\s*:\s*(\S+)/i.exec(line);
    if (v) {
      voice = v[1];
      continue;
    }
    if (/^[A-Za-z]\s*:/.test(line)) continue; // other field / lyric lines
    const bars = line.replace(/%.*$/, "").split(/\|\]|\[\||\|\||:\||\|:|\|/);
    for (let piece of bars) {
      piece = piece.replace(/^\s*\[?\d+(?=[\s[A-Za-z"^_=(]|$)/, "").trim(); // volta numbers
      if (!piece) continue;
      barNo[voice] = (barNo[voice] ?? 0) + 1;
      const annotated = /"[^"]*(GAP|\?)[^"]*"/i.test(piece);
      const stripped = piece
        .replace(/"[^"]*"/g, "")
        .replace(/![^!]*!/g, "")
        .replace(/\[[A-Za-z]:[^\]]*\]/g, "")
        .replace(/[\s()<>~.-]/g, "");
      const restOnly = /^[zxZX\d/]*$/.test(stripped) && /[zxZX]/.test(stripped);
      out.push({ voice, n: barNo[voice], text: piece.replace(/\s+/g, " "), gap: annotated || restOnly });
    }
  }
  return out;
}

export function findGaps(abc: string): string[] {
  const byVoice = new Map<string, number[]>();
  for (const b of barsOf(abc)) {
    if (!b.gap) continue;
    const list = byVoice.get(b.voice) ?? [];
    list.push(b.n);
    byVoice.set(b.voice, list);
  }
  const out: string[] = [];
  for (const [vid, nums] of byVoice) {
    let start = nums[0];
    let prev = nums[0];
    const label = vid === "default" ? "" : vid + " ";
    const flush = () => out.push(label + (start === prev ? `bar ${start}` : `bars ${start}-${prev}`));
    for (const n of nums.slice(1)) {
      if (n === prev + 1) prev = n;
      else {
        flush();
        start = prev = n;
      }
    }
    flush();
  }
  return out;
}

/**
 * Edit guard: everything that is NOT a gap in `original` must be unchanged in `edited`
 * (same headers M/L/K, same bar count per voice, identical bars outside the gaps).
 * Returns human-readable violations; empty means the edit stayed inside the gap.
 */
export function changesOutsideGaps(original: string, edited: string): string[] {
  const problems: string[] = [];
  const h1 = parseHeaders(original);
  const h2 = parseHeaders(edited);
  for (const k of ["m", "l", "k"] as const) {
    if ((h1[k] ?? "").replace(/\s+/g, "") !== (h2[k] ?? "").replace(/\s+/g, "")) {
      problems.push(`header ${k.toUpperCase()}: changed from "${h1[k] ?? ""}" to "${h2[k] ?? ""}"`);
    }
  }
  const a = barsOf(original);
  const b = barsOf(edited);
  const count = (bars: BarInfo[]) => {
    const m = new Map<string, number>();
    for (const x of bars) m.set(x.voice, (m.get(x.voice) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  for (const [v, n] of ca) {
    if ((cb.get(v) ?? 0) !== n) problems.push(`voice ${v}: bar count changed from ${n} to ${cb.get(v) ?? 0}`);
  }
  if (problems.some((p) => p.includes("bar count"))) return problems; // positions no longer comparable
  const edit = new Map(b.map((x) => [`${x.voice}#${x.n}`, x]));
  for (const x of a) {
    if (x.gap) continue;
    const y = edit.get(`${x.voice}#${x.n}`);
    if (y && y.text !== x.text) {
      problems.push(`${x.voice === "default" ? "" : x.voice + " "}bar ${x.n} was changed: "${x.text}" -> "${y.text}"`);
    }
  }
  return problems;
}

export function analyzeScore(abc: string): ScoreAnalysis {
  const h = parseHeaders(abc);
  const meter = meterOf(abc);
  const tonic = tonicOf(h.k);
  const voices = voicesOf(abc);
  const lastPc = lastNotePc(abc);
  return {
    bars: countBars(abc),
    meter: `${meter.num}/${meter.den}`,
    key: h.k ?? "C",
    tonic: tonic.name,
    minor: tonic.minor,
    voices,
    voiceCount: voices.length,
    endsOnTonic: lastPc === null ? null : lastPc === tonic.pc,
    gaps: findGaps(abc),
  };
}

export function formatAnalysis(a: ScoreAnalysis): string {
  return [
    `- bars: ${a.bars} (approximate)`,
    `- meter: ${a.meter}`,
    `- key: ${a.key} (tonic ${a.tonic}${a.minor ? ", minor-ish" : ""})`,
    `- voices: ${a.voiceCount} (${a.voices.join(", ")})`,
    `- ends on tonic: ${a.endsOnTonic === null ? "unknown" : a.endsOnTonic ? "yes" : "NO"}`,
    `- candidate gaps (rest-only / "GAP" bars): ${a.gaps.length ? a.gaps.join("; ") : "none"}`,
  ].join("\n");
}

/* ----------------------------- transposition ----------------------------- */
/*
 * Key-signature-aware, spelling-preserving transposition.
 *
 *  - reads each note's real pitch using the key signature and in-bar accidentals
 *  - moves it diatonically (same number of letter steps as the key moves) so that
 *    F# in G major becomes C# in D major, and Bb in F major stays a B in the key
 *  - re-emits only the accidentals that the NEW key signature / bar state needs
 *  - leaves headers, voice lines, quoted chords, !decorations! and comments alone
 */

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
/** Circle-of-fifths position of each natural major key (C=0, G=1, F=-1, ...). */
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

/** Mode -> fifths offset relative to the major key on the same tonic. */
const MODE_FIFTHS: Record<string, number> = {
  maj: 0, ion: 0, mix: -1, dor: -2, aeo: -3, min: -3, m: -3, phr: -4, lyd: 1, loc: -5,
};

interface KeyInfo {
  letter: string; // tonic letter A-G
  acc: number; // tonic accidental -1/0/1
  modeText: string; // text after the tonic accidental, e.g. "m", " dor", " clef=bass"
  modeFifths: number;
}

function parseKey(value: string): KeyInfo {
  const m = /^\s*([A-Ga-g])([#b]?)(.*)$/.exec(value);
  if (!m) return { letter: "C", acc: 0, modeText: value.trim() ? " " + value.trim() : "", modeFifths: 0 };
  const rest = m[3];
  const word = rest.trim().toLowerCase();
  let modeFifths = 0;
  if (/^(maj)/.test(word) || /^ion/.test(word)) modeFifths = 0;
  else if (/^mix/.test(word)) modeFifths = MODE_FIFTHS.mix;
  else if (/^dor/.test(word)) modeFifths = MODE_FIFTHS.dor;
  else if (/^phr/.test(word)) modeFifths = MODE_FIFTHS.phr;
  else if (/^lyd/.test(word)) modeFifths = MODE_FIFTHS.lyd;
  else if (/^loc/.test(word)) modeFifths = MODE_FIFTHS.loc;
  else if (/^(aeo|min|m(?![a-z]))/.test(word)) modeFifths = MODE_FIFTHS.min;
  return {
    letter: m[1].toUpperCase(),
    acc: m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0,
    modeText: rest,
    modeFifths,
  };
}

function tonicPc(k: KeyInfo): number {
  return (((LETTER_PC[LETTERS.indexOf(k.letter)] + k.acc) % 12) + 12) % 12;
}

/** Signed number of sharps (+) or flats (-) in the key signature. */
function fifthsOf(k: KeyInfo): number {
  return LETTER_FIFTHS[k.letter] + 7 * k.acc + k.modeFifths;
}

function signatureOf(fifths: number): number[] {
  const sig = [0, 0, 0, 0, 0, 0, 0]; // indexed like LETTERS (C D E F G A B)
  if (fifths > 0) for (let i = 0; i < Math.min(7, fifths); i++) sig[LETTERS.indexOf(SHARP_ORDER[i])] = 1;
  if (fifths < 0) for (let i = 0; i < Math.min(7, -fifths); i++) sig[LETTERS.indexOf(FLAT_ORDER[i])] = -1;
  return sig;
}

/** Spell the transposed tonic using the candidate with the fewest accidentals. */
function transposeKey(k: KeyInfo, semitones: number): KeyInfo {
  const target = (((tonicPc(k) + semitones) % 12) + 12) % 12;
  const oldFifths = fifthsOf(k);
  let best: KeyInfo | null = null;
  let bestScore = Infinity;
  for (const letter of LETTERS) {
    for (const acc of [-1, 0, 1]) {
      const cand: KeyInfo = { letter, acc, modeText: k.modeText, modeFifths: k.modeFifths };
      if (tonicPc(cand) !== target) continue;
      const f = fifthsOf(cand);
      // fewest accidentals; on a tie keep the direction (sharps/flats) of the old key
      const score = Math.abs(f) * 10 + (f * oldFifths < 0 ? 1 : 0);
      if (score < bestScore) {
        best = cand;
        bestScore = score;
      }
    }
  }
  return best ?? k;
}

function keyText(k: KeyInfo): string {
  return k.letter + (k.acc > 0 ? "#" : k.acc < 0 ? "b" : "") + k.modeText;
}

interface Ctx {
  oldSig: number[];
  newSig: number[];
  newKey: KeyInfo;
  stepsTotal: number; // diatonic steps to move every note
  semitones: number;
}

function makeCtx(keyValue: string, semitones: number): Ctx {
  const oldKey = parseKey(keyValue);
  const newKey = transposeKey(oldKey, semitones);
  const t = (((tonicPc(newKey) - tonicPc(oldKey)) % 12) + 12) % 12;
  const stepShift = (((LETTERS.indexOf(newKey.letter) - LETTERS.indexOf(oldKey.letter)) % 7) + 7) % 7;
  const octaves = Math.round((semitones - t) / 12);
  return {
    oldSig: signatureOf(fifthsOf(oldKey)),
    newSig: signatureOf(fifthsOf(newKey)),
    newKey,
    stepsTotal: stepShift + 7 * octaves,
    semitones,
  };
}

const ACC_TEXT: Record<number, string> = { "-2": "__", "-1": "_", 0: "=", 1: "^", 2: "^^" };

/** Tokens inside a music line that must NOT be scanned for notes. */
const TOKEN_RE =
  /"[^"]*"|![^!]*!|\+[^+\s]*\+|%.*$|\[[A-Za-z]:[^\]]*\]|(\|\]|\[\||\|\||:\||\|:|\||::)|([=_^]{0,2})([a-gA-G])([',]*)/g;


/** Shift one chord root (letter + accidental) diatonically, preserving its function. */
function shiftChordRoot(letter: string, accText: string, ctx: Ctx): string {
  const li = LETTERS.indexOf(letter);
  const acc = accText === "#" ? 1 : accText === "b" ? -1 : 0;
  const pc = (((LETTER_PC[li] + acc + ctx.semitones) % 12) + 12) % 12;
  const nli = (((li + ctx.stepsTotal) % 7) + 7) % 7;
  let d = pc - LETTER_PC[nli];
  if (d > 6) d -= 12;
  if (d < -6) d += 12;
  if (Math.abs(d) > 1) {
    // awkward spelling (e.g. double sharp): use the plain sharp/flat name of the pitch class
    const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    return names[pc];
  }
  return LETTERS[nli] + (d > 0 ? "#" : d < 0 ? "b" : "");
}

const CHORD_RE = new RegExp(
  "^([A-G])([#b]?)((?:maj|min|dim|aug|sus|add|alt|m|M|[0-9+°ø()#b-])*)(?:/([A-G])([#b]?))?$",
);

/** Transpose a quoted chord symbol such as "Am7/G"; returns null for annotations/text. */
function transposeChordSymbol(quoted: string, ctx: Ctx): string | null {
  const m = CHORD_RE.exec(quoted.slice(1, -1));
  if (!m) return null;
  let out = shiftChordRoot(m[1], m[2], ctx) + m[3];
  if (m[4]) out += "/" + shiftChordRoot(m[4], m[5], ctx);
  return '"' + out + '"';
}

function transposeBodyLine(line: string, ctxRef: { ctx: Ctx }, bars: { old: Map<string, number>; neu: Map<string, number> }): string {
  return line.replace(
    TOKEN_RE,
    (match: string, barline?: string, acc?: string, letter?: string, marks?: string) => {
      if (barline) {
        bars.old.clear();
        bars.neu.clear();
        return match;
      }
      if (letter === undefined) {
        const f = /^\[K:\s*([^\]]*)\]$/.exec(match);
        if (f) {
          ctxRef.ctx = makeCtx(f[1], ctxRef.ctx.semitones);
          bars.old.clear();
          bars.neu.clear();
          return `[K:${keyText(ctxRef.ctx.newKey)}]`;
        }
        if (match.startsWith('"')) return transposeChordSymbol(match, ctxRef.ctx) ?? match;
        return match; // annotation, decoration, comment, other inline field
      }
      const ctx = ctxRef.ctx;
      const up = letter === letter.toUpperCase();
      const li = LETTERS.indexOf(letter.toUpperCase());
      const oct = (up ? 4 : 5) + (marks!.match(/'/g) ?? []).length - (marks!.match(/,/g) ?? []).length;

      // --- read the real old pitch
      const oldKeyId = `${li}:${oct}`;
      let oldAcc = ctx.oldSig[li];
      if (acc) {
        oldAcc = acc === "=" ? 0 : acc.includes("^") ? acc.length : -acc.length;
        bars.old.set(oldKeyId, oldAcc);
      } else if (bars.old.has(oldKeyId)) {
        oldAcc = bars.old.get(oldKeyId)!;
      }
      const midi = (oct + 1) * 12 + LETTER_PC[li] + oldAcc;
      const newMidi = midi + ctx.semitones;

      // --- diatonic move, then work out the accidental the new letter needs
      const dn = oct * 7 + li + ctx.stepsTotal;
      let nli = ((dn % 7) + 7) % 7;
      let noct = Math.floor(dn / 7);
      let need = newMidi - ((noct + 1) * 12 + LETTER_PC[nli]);
      if (need < -2 || need > 2) {
        // pathological spelling: fall back to a sharp spelling of the pitch
        const pc = ((newMidi % 12) + 12) % 12;
        noct = Math.floor(newMidi / 12) - 1;
        const sharpLetter = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc];
        nli = sharpLetter;
        need = pc - LETTER_PC[sharpLetter];
      }

      // --- emit only what the new key / bar state requires
      const newKeyId = `${nli}:${noct}`;
      const effective = bars.neu.has(newKeyId) ? bars.neu.get(newKeyId)! : ctx.newSig[nli];
      let accOut = "";
      if (need !== effective) {
        accOut = ACC_TEXT[need];
        bars.neu.set(newKeyId, need);
      }
      const upper = noct <= 4;
      const markers = upper ? 4 - noct : noct - 5;
      const markOut = upper ? ",".repeat(markers) : "'".repeat(markers);
      const name = upper ? LETTERS[nli] : LETTERS[nli].toLowerCase();
      return accOut + name + markOut;
    },
  );
}

/**
 * Transpose an ABC score by `semitones` (negative = down). Key-signature aware;
 * preserves spelling (F# -> C# in D major, Bb written as a plain B in F major).
 */
export function transposeAbc(abc: string, semitones: number): string {
  if (!Number.isInteger(semitones) || semitones === 0) return abc;
  const lines = abc.split(/\r?\n/);
  const out: string[] = [];
  let inBody = false;
  const ctxRef = { ctx: makeCtx("C", semitones) };
  const bars = { old: new Map<string, number>(), neu: new Map<string, number>() };
  for (const line of lines) {
    if (!inBody) {
      const k = /^(\s*K\s*:\s*)(.*)$/i.exec(line);
      if (k && !/^\s*K\s*:\s*(none|Hp|HP)\b/i.test(line)) {
        ctxRef.ctx = makeCtx(k[2], semitones);
        out.push(k[1] + keyText(ctxRef.ctx.newKey));
        inBody = true;
      } else {
        out.push(line);
        if (k) inBody = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%")) {
      out.push(line);
      continue;
    }
    const field = /^([A-Za-z]):/.exec(trimmed);
    if (field) {
      if (field[1].toUpperCase() === "V") {
        bars.old.clear();
        bars.neu.clear();
      }
      // a K: line inside the body changes the key; every other info field is text
      const k = /^(\s*K\s*:\s*)(.*)$/i.exec(line);
      if (k) {
        ctxRef.ctx = makeCtx(k[2], semitones);
        out.push(k[1] + keyText(ctxRef.ctx.newKey));
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(transposeBodyLine(line, ctxRef, bars));
  }
  return out.join("\n");
}
