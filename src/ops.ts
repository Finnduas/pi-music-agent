// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Operations shared by the CLI and the HTTP server (so both behave identically). */

import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { convertSheetMusic, type ConvertResult } from "./convert/convert.js";
import { transposeAbc } from "./music/abc.js";

/** Convert a PDF/image/MusicXML/ABC file to validated ABC and save it as <outDir>/<name>.abc. */
export async function convertAndSave(
  inputPath: string,
  cfg: AppConfig,
  outDir: string,
): Promise<{ result: ConvertResult; outPath?: string }> {
  const result = await convertSheetMusic(inputPath, cfg);
  if (!result.valid) return { result };
  await fs.mkdir(outDir, { recursive: true });
  const base = path.basename(inputPath, path.extname(inputPath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "piece";
  const outPath = path.join(outDir, `${base}.abc`);
  await fs.writeFile(outPath, result.abc + "\n");
  return { result, outPath };
}

/** Transpose ABC text and save it as <outDir>/<name>.abc. */
export async function transposeAndSave(
  abc: string,
  semitones: number,
  name: string,
  outDir: string,
): Promise<{ abc: string; outPath: string }> {
  const out = transposeAbc(abc, semitones);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${name}.abc`);
  await fs.writeFile(outPath, out + "\n");
  return { abc: out, outPath };
}

/** Read every .abc file in a folder (style references). Missing folder -> []. */
export async function readAbcFiles(dir: string): Promise<string[]> {
  const abs = path.resolve(process.cwd(), dir);
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(abs)).filter((f) => f.toLowerCase().endsWith(".abc"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) out.push(await fs.readFile(path.join(abs, e), "utf8"));
  return out;
}
