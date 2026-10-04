// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import yaml from "js-yaml";

export type ProviderName = string;

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface RoleConfig {
  provider: ProviderName;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AppConfig {
  storage: {
    dir: string;
    inputDir?: string;
    database?: string;
  };
  providers: Record<ProviderName, ProviderConfig>;
  roles: {
    composer: RoleConfig;
    critic: RoleConfig;
  };
  validation: {
    backend: "local" | "n8n";
    n8n: { webhookUrl: string; timeoutMs: number };
  };
  conversion: {
    backend: "none" | "local" | "n8n";
    n8n: { webhookUrl: string; timeoutMs: number };
    local: { audiveris: string; music21: string };
  };
  render: {
    prefer: string[];
    formats: string[];
    abc2svgPath: string;
    abcm2psPath: string;
  };
  loop: {
    maxValidationRetries: number;
    maxIterations: number;
    scoreThreshold: number;
  };
}

const DEFAULTS: AppConfig = {
  storage: { dir: "./.output", inputDir: "./.input" },
  providers: {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://localhost/pi-music-agent",
        "X-Title": "pi-music-agent",
      },
    },
    ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama" },
  },
  roles: {
    composer: {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      temperature: 0.9,
      maxTokens: 4096,
    },
    critic: {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      temperature: 0.2,
      maxTokens: 4096,
    },
  },
  validation: {
    backend: "local",
    n8n: {
      webhookUrl: "http://localhost:5678/webhook/notation-validation",
      timeoutMs: 15000,
    },
  },
  conversion: {
    backend: "none",
    n8n: {
      webhookUrl: "http://localhost:5678/webhook/omr-conversion",
      timeoutMs: 120000,
    },
    local: { audiveris: "audiveris", music21: "python" },
  },
  render: {
    prefer: ["abc2svg", "abcm2ps"],
    formats: ["svg", "html"],
    abc2svgPath: "abc2svg",
    abcm2psPath: "abcm2ps",
  },
  loop: { maxValidationRetries: 5, maxIterations: 3, scoreThreshold: 8 },
};

export const projectRoot = findProjectRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);

/** Walk up from this file (src/ or dist/) until package.json is found. */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function readKeyFromEnv(provider: string): string | undefined {
  const map: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    ollama: "OLLAMA_API_KEY",
  };
  return process.env[map[provider] ?? `${provider.toUpperCase()}_API_KEY`];
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base)) return override as T;
  if (typeof override !== "object" || Array.isArray(override)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** Resolve config file path: explicit arg > ./config.yaml > defaults. */
export function resolveConfigPath(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    path.resolve(process.cwd(), "config.yaml"),
    path.join(projectRoot, "config.yaml"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

/** Clamp loop/timeout values so a bad config cannot dead-end or no-op the loop. */
function sanitizeConfig(cfg: AppConfig): AppConfig {
  const clamp = (value: number, min: number, max: number, fallback: number, label: string) => {
    if (Number.isFinite(value) && value >= min && value <= max) return value;
    console.error(`[config] ${label} must be ${min}..${max}; got ${value}, using ${fallback}.`);
    return fallback;
  };
  cfg.loop.scoreThreshold = clamp(cfg.loop.scoreThreshold, 0, 10, 8, "loop.scoreThreshold");
  cfg.loop.maxIterations = clamp(
    cfg.loop.maxIterations,
    1,
    Number.POSITIVE_INFINITY,
    3,
    "loop.maxIterations",
  );
  cfg.loop.maxValidationRetries = clamp(
    cfg.loop.maxValidationRetries,
    1,
    Number.POSITIVE_INFINITY,
    5,
    "loop.maxValidationRetries",
  );
  cfg.validation.n8n.timeoutMs = clamp(
    cfg.validation.n8n.timeoutMs,
    1,
    Number.POSITIVE_INFINITY,
    15000,
    "validation.n8n.timeoutMs",
  );
  return cfg;
}

export function loadConfig(explicit?: string): AppConfig {
  const configPath = resolveConfigPath(explicit);
  let raw: unknown = {};
  if (configPath) {
    raw = yaml.load(fs.readFileSync(configPath, "utf8")) ?? {};
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), raw);

  // Resolve API keys: env var wins when the config value is empty.
  for (const [name, prov] of Object.entries(cfg.providers)) {
    const envKey = readKeyFromEnv(name);
    if (!prov.apiKey && envKey) prov.apiKey = envKey;
    if (!prov.apiKey && name === "openrouter") {
      // fall back to pi's own auth store, if present
      const piAuth = path.join(
        process.env.USERPROFILE ?? process.env.HOME ?? "",
        ".pi",
        "agent",
        "auth.json",
      );
      try {
        const auth = JSON.parse(fs.readFileSync(piAuth, "utf8"));
        if (auth?.openrouter?.key) prov.apiKey = auth.openrouter.key;
      } catch {
        /* ignore */
      }
    }
  }

  cfg.storage.dir = path.resolve(process.cwd(), cfg.storage.dir);
  if (cfg.storage.inputDir) {
    cfg.storage.inputDir = path.resolve(process.cwd(), cfg.storage.inputDir);
  }
  return sanitizeConfig(cfg);
}
