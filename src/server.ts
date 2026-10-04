// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/**
 * Local HTTP API so automation tools (n8n) can drive the music agent.
 *
 *   GET  /health
 *   POST /analyze    { file | abc }
 *   POST /compose    { request, style?, title?, refs? }
 *   POST /edit       { file, instruction, style?, title? }
 *   POST /transpose  { file | abc, semitones, name? }
 *   POST /convert    { file }
 *
 * Binds to 127.0.0.1 only. `file`/`refs` must resolve inside the project folder.
 * Every response is JSON; errors are { error } with a 4xx/5xx status.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { projectRoot } from "./config.js";
import { composePiece } from "./loop/orchestrator.js";
import { analyzeScore, parseHeaders } from "./music/abc.js";
import { convertAndSave, readAbcFiles, transposeAndSave } from "./ops.js";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Resolve a user-supplied path; it must stay inside the project folder. */
export function resolveInside(root: string, p: unknown): string {
  if (typeof p !== "string" || !p.trim()) throw new HttpError(400, "A file path is required.");
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(400, `Path "${p}" is outside the project folder.`);
  }
  return abs;
}

function str(v: unknown, field: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `"${field}" is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `"${field}" must be a string.`);
  return v;
}

async function abcFrom(body: any, root: string): Promise<{ abc: string; name: string }> {
  if (typeof body.abc === "string" && body.abc.trim()) return { abc: body.abc, name: "piece" };
  const file = resolveInside(root, body.file);
  try {
    return { abc: await fs.readFile(file, "utf8"), name: path.basename(file, path.extname(file)) };
  } catch {
    throw new HttpError(404, `File not found: ${body.file}`);
  }
}

export function createServer(cfg: AppConfig, root = projectRoot): http.Server {
  const routes: Record<string, (body: any) => Promise<unknown>> = {
    "POST /analyze": async (body) => {
      const { abc } = await abcFrom(body, root);
      // echo the file so a workflow can keep passing it along
      return { file: typeof body.file === "string" ? body.file : undefined, ...analyzeScore(abc) };
    },

    "POST /compose": async (body) => {
      const request = str(body.request, "request", true)!;
      const refsDir = str(body.refs, "refs");
      const references = refsDir ? await readAbcFiles(resolveInside(root, refsDir)) : undefined;
      const r = await composePiece(
        { request, style: str(body.style, "style"), title: str(body.title, "title"), references },
        { config: cfg },
      );
      return summarize(r);
    },

    "POST /edit": async (body) => {
      const instruction = str(body.instruction, "instruction", true)!;
      const { abc, name } = await abcFrom(body, root);
      const r = await composePiece(
        {
          request: instruction,
          style: str(body.style, "style"),
          title: str(body.title, "title") ?? parseHeaders(abc).t ?? name,
          existingAbc: abc,
          edit: true,
        },
        { config: cfg },
      );
      return summarize(r);
    },

    "POST /transpose": async (body) => {
      const n = Number(body.semitones);
      if (!Number.isInteger(n)) throw new HttpError(400, '"semitones" must be an integer.');
      const { abc, name } = await abcFrom(body, root);
      const outName = str(body.name, "name") ?? `${name}-${n >= 0 ? "+" : ""}${n}`;
      const out = await transposeAndSave(abc, n, outName.replace(/[^\w.+-]+/g, "-"), cfg.storage.dir);
      return { abc: out.abc, file: out.outPath };
    },

    "POST /convert": async (body) => {
      const file = resolveInside(root, body.file);
      const { result, outPath } = await convertAndSave(file, cfg, cfg.storage.dir);
      return { ...result, file: outPath ?? null };
    },
  };

  return http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true, routes: Object.keys(routes) });
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, `No route ${req.method} ${url.pathname}`);

      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 25_000_000) throw new HttpError(413, "Request body too large.");
      }
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new HttpError(400, "Body must be JSON.");
      }
      send(200, await handler(body));
    } catch (e: any) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      send(500, { error: e?.message ?? String(e) });
    }
  });
}

/** The fields automation needs, without the full log/transcript. */
function summarize(r: Awaited<ReturnType<typeof composePiece>>) {
  return {
    id: r.id,
    title: r.title,
    score: r.critic?.score ?? null,
    summary: r.critic?.summary ?? "",
    iterations: r.iterations,
    abc: r.abc,
    files: r.files,
    warnings: r.validationWarnings,
    seconds: Math.round(r.durationMs / 100) / 10,
  };
}
