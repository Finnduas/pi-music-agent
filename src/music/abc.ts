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
  };
}

export function formatAnalysis(a: ScoreAnalysis): string {
  return [
    `- bars: ${a.bars} (approximate)`,
    `- meter: ${a.meter}`,
    `- key: ${a.key} (tonic ${a.tonic}${a.minor ? ", minor-ish" : ""})`,
    `- voices: ${a.voiceCount} (${a.voices.join(", ")})`,
    `- ends on tonic: ${a.endsOnTonic === null ? "unknown" : a.endsOnTonic ? "yes" : "NO"}`,
  ].join("\n");
}

/* ----------------------------- transposition ----------------------------- */

function noteEmitted(acc: string, letter: string, oct: string, dur: string, delta: number): string {
  const oldPc = pitchClassOf(acc === "=" ? "" : acc, letter);
  const markerCount = (oct.match(/'/g) ?? []).length - (oct.match(/,/g) ?? []).length;
  const baseOct = /[a-g]/.test(letter) ? 5 : 4;
  const oldMidi = (baseOct + markerCount) * 12 + oldPc;
  const newMidi = oldMidi + delta;
  const newOct = Math.floor(newMidi / 12);
  const newPc = ((newMidi % 12) + 12) % 12;
  const name = SHARP_NAMES[newPc];
  const sharp = name.endsWith("#");
  const bare = sharp ? name[0] : name;
  const upper = newOct <= 4;
  const markers = upper ? newOct - 4 : newOct - 5;
  const octStr = markers > 0 ? "'".repeat(markers) : markers < 0 ? ",".repeat(-markers) : "";
  const letterOut = upper ? bare.toUpperCase() : bare.toLowerCase();
  return (sharp ? "^" : "") + letterOut + octStr + (dur ?? "");
}

function transposeLine(line: string, delta: number): string {
  if (/^\s*(w|s)\s*:/i.test(line)) return line;
  const protectedSegments: string[] = [];
  let buf = line;
  // Protect quoted text and inline [K:...]/[M:...]/[L:...] directives.
  buf = buf.replace(/"[^"]*"/g, (s) => protect(protectedSegments, s));
  buf = buf.replace(/\[[^\]]*:[^\]]*\]/g, (s) => protect(protectedSegments, s));
  buf = buf.replace(NOTE_RE, (m, acc, letter, oct, dur) =>
    noteEmitted(acc ?? "", letter ?? m, oct ?? "", dur ?? "", delta),
  );
  return buf.replace(/\u0000(\d+)\u0000/g, (_m, idx) => protectedSegments[Number(idx)]);
}

function protect(segments: string[], s: string): string {
  segments.push(s);
  return `\u0000${segments.length - 1}\u0000`;
}

function transposeKeyValue(key: string, delta: number): string {
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(key.trim());
  if (!m) return key;
  const letter = m[1].toUpperCase();
  const accidental = m[2];
  const oldPc = pitchClassOf(accidental === "#" ? "^" : accidental === "b" ? "_" : "", letter);
  const newPc = ((oldPc + delta) % 12 + 12) % 12;
  return SHARP_NAMES[newPc] + m[3];
}

/** Best-effort chromatic transposition (preserves structure, spells in sharps). */
export function transposeAbc(abc: string, semitones: number): string {
  const delta = ((semitones % 12) + 12) % 12;
  if (delta === 0) return abc;
  const lines = abc.split(/\r?\n/);
  const out: string[] = [];
  let inBody = false;
  for (const line of lines) {
    if (!inBody) {
      if (/^\s*K\s*:/i.test(line.trim())) {
        out.push(line.replace(/^(\s*K\s*:\s*)(.*)$/i, (_m, p1, p2) => p1 + transposeKeyValue(p2, delta)));
        inBody = true;
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(transposeLine(line, delta));
  }
  return out.join("\n");
}