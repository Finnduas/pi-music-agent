// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** ABC validation: local abcjs parse (default) or the n8n webhook backend. */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  backend: "local" | "n8n";
}

export interface ValidationRequest {
  notation: string;
  title?: string;
  style?: string;
}

export interface Validator {
  validate(req: ValidationRequest): Promise<ValidationResult>;
}

/* --------------------------- local abcjs backend ------------------------- */

interface AbcjsTune {
  warnings?: string[];
  lines?: { staff?: unknown[] }[];
}

/** Strip the HTML markup abcjs embeds in warning strings. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function validateWithAbcjs(notation: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let tunes: AbcjsTune[] = [];
  try {
    const mod: any = await import("abcjs");
    const abcjs = mod.default ?? mod;
    // parseOnly is headless (renderAbc needs a DOM).
    tunes = abcjs.parseOnly(notation) as AbcjsTune[];
  } catch (e: any) {
    errors.push(`abcjs parse error: ${e?.message ?? String(e)}`);
    return { valid: false, errors, warnings, backend: "local" };
  }

  if (!Array.isArray(tunes) || tunes.length === 0) {
    errors.push("No tunes found in notation.");
    return { valid: false, errors, warnings, backend: "local" };
  }

  let totalStaff = 0;
  for (const tune of tunes) {
    for (const w of tune.warnings ?? []) warnings.push(stripTags(String(w)));
    const staffCount = (tune.lines ?? []).reduce(
      (n, l) => n + (l.staff ?? []).length,
      0,
    );
    totalStaff += staffCount;
  }
  if (totalStaff === 0) {
    errors.push("No staff content parsed (nothing to engrave).");
  }

  if (!/^\s*X\s*:/m.test(notation)) errors.push("Missing required X: (tune number) header.");
  if (!/^\s*K\s*:/m.test(notation)) errors.push("Missing required K: (key) header.");
  if (!/^\s*M\s*:/m.test(notation) && !/\[M:/.test(notation)) {
    warnings.push("No M: (meter) header; defaulting to 4/4.");
  }
  if (!/^\s*L\s*:/m.test(notation) && !/\[L:/.test(notation)) {
    warnings.push("No L: (default note length) header.");
  }

  return { valid: errors.length === 0, errors, warnings, backend: "local" };
}

/* ----------------------------- n8n backend ------------------------------- */

async function validateWithN8n(
  req: ValidationRequest,
  webhookUrl: string,
  timeoutMs: number,
): Promise<ValidationResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        valid: false,
        errors: [`n8n webhook returned ${res.status} ${res.statusText}`],
        warnings: [],
        backend: "n8n",
      };
    }
    const json: any = await res.json();
    return {
      valid: Boolean(json.valid),
      errors: json.errors ?? [],
      warnings: json.warnings ?? [],
      backend: "n8n",
    };
  } catch (e: any) {
    return {
      valid: false,
      errors: [`n8n webhook unreachable: ${e?.message ?? String(e)}`],
      warnings: [],
      backend: "n8n",
    };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------ public API ------------------------------- */

export function createValidator(opts: {
  backend: "local" | "n8n";
  n8n: { webhookUrl: string; timeoutMs: number };
}): Validator {
  if (opts.backend === "n8n") {
    return {
      validate: (req) =>
        validateWithN8n(req, opts.n8n.webhookUrl, opts.n8n.timeoutMs),
    };
  }
  return { validate: (req) => validateWithAbcjs(req.notation) };
}
