// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Offline smoke test for key-signature-aware transposition.
 * Run: npx tsx scripts/smoke-transpose.ts
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { transposeAbc } from "../src/music/abc.js";

const abcjs: any = createRequire(import.meta.url)("abcjs");

let failed = false;
function check(name: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) failed = true;
}

/** Last line of the transposed score (the music). */
const last = (abc: string, n: number) => transposeAbc(abc, n).split("\n").slice(-1)[0];
/** Everything except header/info-field lines. */
const body = (abc: string) =>
  abc
    .split("\n")
    .filter((l) => !/^[A-Z]:/.test(l))
    .join("\n");

// key header + key-signature awareness: F in K:D is F#; +2 -> K:E where G# is in the key
const up2 = transposeAbc("X:1\nK:D\nD E F G |]", 2);
check("D -> E key header", up2.includes("K:E"));
check("D->E: F# becomes G# (from the key signature, no accidental)", up2.includes("E F G A"));

// the classic bug: Bb in F major must be a plain B, never ^A
check("C->F: F becomes B (Bb via key signature)", last("X:1\nK:C\nF|]", 5) === "B|]");
check("C->F emits no sharps", !transposeAbc("X:1\nK:C\nE F G A B c|]", 5).includes("^"));
check("C->F whole scale", last("X:1\nK:C\nC D E F G A B c|]", 5) === "F G A B c d e f|]");

// sharp keys keep their spelling
check("G->D: F# -> C# via key sig", last("X:1\nK:G\nG A B c d e F g|]", 7) === "d e f g a b c d'|]");

// direction matters
check("-7 goes down a fifth", last("X:1\nK:G\nd|]", -7) === "G|]");
check("+12 is an octave up", last("X:1\nK:C\nC|]", 12) === "c|]");

// accidentals inside a bar persist and are re-spelled consistently
check("bar accidental persists", last("X:1\nK:C\nc ^c c |]", 2) === "d ^d d |]");
check("bar accidental resets at barline", last("X:1\nK:C\n^c | c|]", 2) === "^d | d|]");

// non-music text is never touched
const duo = transposeAbc('X:1\nK:Dm\nV:RH clef=treble\n!trill!d2 "Am"e2 |\nV:LH clef=bass\nD,4|]', 2);
check("V: lines untouched", duo.includes("V:RH clef=treble") && duo.includes("V:LH clef=bass"));
check("decorations untouched, chord symbols transposed", duo.includes('!trill!e2 "Bm"f2 |'));
const chords = (abc: string, n: number) => (transposeAbc(abc, n).match(/"[^"]*"/g) ?? []).join(" ");
check(
  "chord symbols follow the key (C->F)",
  chords('X:1\nK:C\n"C"C "Am7"A "G7/B"G "Dm"D|]', 5) === '"F" "Dm7" "C7/E" "Gm"',
);
check(
  "chord symbols use key-appropriate spelling (C->D)",
  chords('X:1\nK:C\n"F"F "E7"E|]', 2) === '"G" "F#7"',
);
check(
  "annotations and plain text are never transposed",
  chords('X:1\nK:C\n"^GAP"C "Allegro"D "<Fine"E "_D.C. al Coda"F|]', 5) ===
    '"^GAP" "Allegro" "<Fine" "_D.C. al Coda"',
);
check("comments untouched", transposeAbc("X:1\nK:C\n%% a comment: bad\nC|]", 2).includes("%% a comment: bad"));
check("lyrics untouched", transposeAbc("X:1\nK:C\nC D|]\nw: ab-cd ef", 2).includes("w: ab-cd ef"));

check("chords", last("X:1\nK:C\n[CEG]|", 2) === "[DFA]|"); // F# comes from K:D
check("inline [K:] is transposed too", transposeAbc("X:1\nK:D\n[K:F] d e |", 2).includes("[K:G]"));
check("B +2 in C -> c (C# via key sig)", last("X:1\nK:C\nB|", 2) === "c|");

// round trips restore the original music exactly
const MINUET = "X:1\nT:Round trip\nM:3/4\nL:1/4\nK:G\nG B d | g2 ^c | e c A | B2 =F | d B G | A3 |]";
for (const n of [2, 5, 7, 3, 1]) {
  const back = transposeAbc(transposeAbc(MINUET, n), -n);
  check(`round trip +${n} then -${n}`, body(back) === body(MINUET));
}
const MINOR = "X:1\nK:Am\nA B c d | e ^g a2 |]";
check("A minor up a 4th -> Dm", transposeAbc(MINOR, 5).includes("K:Dm"));
check("minor round trip", body(transposeAbc(transposeAbc(MINOR, 5), -5)) === body(MINOR));

if (failed) {
  console.error("\nTranspose smoke checks failed.");
  process.exit(1);
}
console.log("\nAll transpose smoke checks passed.");
