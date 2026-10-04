// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Offline smoke test for the deterministic ABC toolkit (analysis + transposition). */
import {
  analyzeScore,
  countBars,
  meterOf,
  parseHeaders,
  tonicOf,
  transposeAbc,
  voicesOf,
} from "../src/music/abc.js";

let failed = false;
function check(name: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) failed = true;
}

const h = parseHeaders("X:1\nT:Etude\nM:3/4\nL:1/8\nK:Dm\nC D E |]");
check("parses M: header", h.m === "3/4");
check("parses K: header", h.k === "Dm");

check("meter 3/4", meterOf("X:1\nM:3/4\nK:C\nC|").num === 3 && meterOf("X:1\nM:3/4\nK:C\nC|").den === 4);
check("meter defaults to 4/4", meterOf("X:1\nK:C\nC|").num === 4);

const twoVoice = `X:1
T:Duo
M:3/4
K:Dm
V:RH clef=treble
V:LH clef=bass
%
V:RH
d2 e2 f2 |]
%
V:LH
D,4 A,,2 |]`;
check("voices RH/LH", JSON.stringify(voicesOf(twoVoice)) === JSON.stringify(["RH", "LH"]));

const tonic = tonicOf("Dm");
check("tonic D minor", tonic.name === "D" && tonic.pc === 2 && tonic.minor === true);
check("tonic F# major", tonicOf("F#").pc === 6 && tonicOf("F#").minor === false);

check("counts 4 bars", countBars("X:1\nK:D\nD E F G | A B c d | E F G A | B c d e |]") === 4);

const a = analyzeScore("X:1\nT:T\nM:4/4\nK:D\nD E F G | A B c d |]");
check("analyze ends on tonic (D)", a.endsOnTonic === true && a.tonic === "D");

check("transpose identity", transposeAbc("X:1\nK:D\nD E F G |]", 0).includes("K:D"));

// (detailed transposition checks live in smoke-transpose.ts)

if (!failed) console.log("\nAll music toolkit smoke checks passed.");
else {
  console.error("\nMusic toolkit smoke checks failed.");
  process.exit(1);
}