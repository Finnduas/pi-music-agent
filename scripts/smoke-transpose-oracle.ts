// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Independent correctness check for transposition.
 *
 * Uses abcjs's own MIDI export as an oracle: for every shift from -11 to +12
 * semitones, every note of the transposed score must sound exactly N semitones
 * away from the original. This verifies pitch logic (key signatures, in-bar
 * accidentals, modes, chords) without trusting our own spelling code.
 *
 * Run: npx tsx scripts/smoke-transpose-oracle.ts
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { transposeAbc } from "../src/music/abc.js";

const abcjs: any = createRequire(import.meta.url)("abcjs");

/** Note-on pitches, in order, exactly as abcjs would play the score. */
function midiPitches(abc: string): number[] {
  const b: Uint8Array = abcjs.synth.getMidiFile(abc, { midiOutputType: "binary" })[0];
  const out: number[] = [];
  let p = 14; // skip the MThd chunk
  while (p + 8 <= b.length) {
    const end = p + 8 + ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
    p += 8;
    let status = 0;
    while (p < end) {
      while (b[p] & 0x80) p++; // delta time (variable-length quantity)
      p++;
      if (b[p] & 0x80) status = b[p++];
      if (status === 0xff) {
        p++; // meta type
        let len = 0;
        do len = (len << 7) | (b[p] & 0x7f);
        while (b[p++] & 0x80);
        p += len;
      } else if (status === 0xf0 || status === 0xf7) {
        let len = 0;
        do len = (len << 7) | (b[p] & 0x7f);
        while (b[p++] & 0x80);
        p += len;
      } else {
        const kind = status & 0xf0;
        if (kind === 0x90 && b[p + 1] > 0) out.push(b[p]);
        p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      }
    }
  }
  return out;
}

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const PIECES: Record<string, string> = {
  "ode (C major)": read("../examples/input/ode-to-joy.abc"),
  // the "^GAP" annotation is a text label; abcjs would play it as a chord, so strip it here
  "minuet (G major, rests)": read("../examples/input/minuet-with-gap.abc").replace('"^GAP" ', ""),
  "accidentals (D major)":
    "X:1\nM:4/4\nL:1/8\nK:D\nD E F ^G A =c c B | ^f f =f f _B B =B z | [DFA]2 [EGB]2 d,2 d'2 |]",
  "minor (A minor)": "X:1\nM:4/4\nL:1/8\nK:Am\nA B c d e ^g a2 | f e d c B ^G A2 |]",
  "flat key (Eb major)": "X:1\nM:3/4\nL:1/4\nK:Eb\nE G B | A =A _A | c2 d |]",
  "dorian (D dorian)": "X:1\nM:4/4\nL:1/8\nK:Ddor\nD E F G A B c d |]",
  "sharp key (B major)": "X:1\nM:4/4\nL:1/8\nK:B\nB, C D E F G A B | c d e f g a b c' |]",
};

let failed = false;
for (const [name, abc] of Object.entries(PIECES)) {
  const base = midiPitches(abc);
  const bad: number[] = [];
  for (let n = -11; n <= 12; n++) {
    if (n === 0) continue;
    const moved = midiPitches(transposeAbc(abc, n));
    const ok = moved.length === base.length && moved.every((p, i) => p === base[i] + n);
    if (!ok) bad.push(n);
  }
  const pass = base.length > 0 && bad.length === 0;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${base.length} notes x 23 shifts exact`);
  if (!pass) {
    failed = true;
    if (bad.length) console.log("   failing shifts:", bad.join(", "));
  }
}

if (failed) {
  console.error("\nTranspose oracle checks failed.");
  process.exit(1);
}
console.log("\nAll transpose oracle checks passed.");
