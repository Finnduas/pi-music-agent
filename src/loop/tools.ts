// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Deterministic "tools" the composer can call to inspect or transform a score. */

import { analyzeScore, formatAnalysis, transposeAbc } from "../music/abc.js";
import type { ToolSpec } from "../llm/openai-client.js";

export function toolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "analyze_score",
        description:
          "Analyze an ABC score and return its approximate bar count, meter, key, tonic, voice list, and whether it ends on the tonic.",
        parameters: {
          type: "object",
          properties: {
            abc: { type: "string", description: "The full ABC notation to analyze." },
          },
          required: ["abc"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "transpose",
        description:
          "Transpose an ABC score by a number of semitones. Best-effort: preserves structure and spells accidentals as sharps.",
        parameters: {
          type: "object",
          properties: {
            abc: { type: "string", description: "The full ABC notation to transpose." },
            semitones: { type: "integer", description: "Number of semitones (negative to go down)." },
          },
          required: ["abc", "semitones"],
        },
      },
    },
  ];
}

/** Executes a tool requested by the model and returns its text result. */
export function executeTool(name: string, argsRaw: string): string {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsRaw || "{}");
  } catch {
    return `Error: could not parse tool arguments: ${argsRaw}`;
  }

  if (name === "analyze_score") {
    const abc = String(args.abc ?? "");
    if (!abc.trim()) return "Error: 'abc' is required.";
    return formatAnalysis(analyzeScore(abc));
  }

  if (name === "transpose") {
    const abc = String(args.abc ?? "");
    const n = Number(args.semitones);
    if (!abc.trim()) return "Error: 'abc' is required.";
    if (!Number.isInteger(n)) return "Error: 'semitones' must be an integer.";
    return transposeAbc(abc, n);
  }

  return `Error: unknown tool "${name}".`;
}