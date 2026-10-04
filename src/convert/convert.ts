// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Convert sheet music (PDF/image/MusicXML) or ABC into validated ABC notation. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { createValidator } from "../validate/validator.js";

const exec = promisify(execFile);

export interface ConvertResult {
  abc: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  backend: string; // "passthrough" | "n8n" | "local" | "none"
  source: string; // basename of the input
}

const IMAGE_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif"]);
const XML_EXTS = new Set([".musicxml", ".xml", ".mxl"]);

function fail(source: string, errors: string[], backend = "none"): ConvertResult {
  return { abc: "", valid: false, errors, warnings: [], backend, source };
}

function mimeFor(ext: string): string {
  switch (ext) {
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".mxl": return "application/vnd.recordare.musicxml";
    case ".musicxml":
    case ".xml": return "application/vnd.recordare.musicxml+xml";
    default: return "application/octet-stream";
  }
}

export async function convertSheetMusic(inputPath: string, cfg: AppConfig): Promise<ConvertResult> {
  const ext = path.extname(inputPath).toLowerCase();
  const source = path.basename(inputPath);

  if (ext === ".abc") {
    const abc = await fs.readFile(inputPath, "utf8");
    const v = await createValidator(cfg.validation).validate({ notation: abc, title: source });
    return { abc, valid: v.valid, errors: v.errors, warnings: v.warnings, backend: "passthrough", source };
  }

  if (!IMAGE_EXTS.has(ext) && !XML_EXTS.has(ext)) {
    return fail(source, [`Unsupported input type "${ext}". Expected PDF, image, MusicXML, or ABC.`]);
  }

  const backend = cfg.conversion.backend;
  if (backend === "n8n") {
    try {
      return await convertViaN8n(cfg, source, ext, await fs.readFile(inputPath));
    } catch (e: any) {
      // n8n unreachable -> fall back to local Audiveris + music21
      const r = await convertLocally(cfg, inputPath, source);
      r.warnings = [...r.warnings, `n8n unavailable (${e?.message ?? String(e)}); used local fallback`];
      return r;
    }
  }
  if (backend === "local") return convertLocally(cfg, inputPath, source);
  return fail(source, [
    'No conversion backend configured. Set `conversion.backend: "n8n"` (recommended) or `"local"` (Audiveris + music21) in config.yaml.',
  ]);
}

async function convertViaN8n(
  cfg: AppConfig,
  source: string,
  ext: string,
  buf: Buffer,
): Promise<ConvertResult> {
  const data = buf.toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.conversion.n8n.timeoutMs);
  try {
    const res = await fetch(cfg.conversion.n8n.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: source, mimeType: mimeFor(ext), data }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`OMR webhook returned ${res.status} ${res.statusText}`);
    }
    const json: any = await res.json();
    return {
      abc: typeof json.abc === "string" ? json.abc : "",
      valid: Boolean(json.valid),
      errors: Array.isArray(json.errors) ? json.errors.map(String) : [],
      warnings: Array.isArray(json.warnings) ? json.warnings.map(String) : [],
      backend: "n8n",
      source,
    };
  } finally {
    clearTimeout(t);
  }
}

async function findFile(dir: string, pattern: RegExp): Promise<string | null> {
  const walk = async (d: string): Promise<string | null> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = await walk(p);
        if (hit) return hit;
      } else if (pattern.test(e.name)) {
        return p;
      }
    }
    return null;
  };
  return walk(dir);
}

function pythonBin(): string {
  return process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

async function convertLocally(cfg: AppConfig, inputPath: string, source: string): Promise<ConvertResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "music-agent-omr-"));
  try {
    const xmlDir = path.join(tmp, "xml");
    await fs.mkdir(xmlDir, { recursive: true });
    await exec(cfg.conversion.local.audiveris, ["-batch", "-export", "-output", xmlDir, inputPath]);
    const musicXml = await findFile(xmlDir, /\.(mxl|musicxml|xml)$/i);
    if (!musicXml) return fail(source, ["Audiveris produced no MusicXML output."], "local");

    const abcOut = path.join(tmp, "score.abc");
    const py = [
      "from music21 import converter",
      `s = converter.parse(r"${musicXml.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`,
      `s.write("abc", fp=r"${abcOut.replace(/\\/g, "\\\\")}")`,
    ].join("\n");
    await exec(cfg.conversion.local.music21 || pythonBin(), ["-c", py]);

    const abc = await fs.readFile(abcOut, "utf8");
    const v = await createValidator(cfg.validation).validate({ notation: abc, title: source });
    return { abc, valid: v.valid, errors: v.errors, warnings: v.warnings, backend: "local", source };
  } catch (e: any) {
    return fail(source, [`Local conversion failed: ${e?.message ?? String(e)}`], "local");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}