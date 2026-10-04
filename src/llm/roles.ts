import type { AppConfig, RoleConfig } from "../config.js";
import { OpenAICompatClient } from "./openai-client.js";

export type Role = "composer" | "critic";

/** Build a client for a role, wiring provider + model + secrets together. */
export function clientForRole(cfg: AppConfig, role: Role) {
  const roleCfg: RoleConfig = cfg.roles[role];
  const provider = cfg.providers[roleCfg.provider];
  if (!provider) {
    throw new Error(`Unknown provider "${roleCfg.provider}" configured for role "${role}".`);
  }
  const client = new OpenAICompatClient(provider);
  return {
    client,
    roleCfg,
    async complete(system: string, user: string, signal?: AbortSignal) {
      const res = await client.chat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        {
          model: roleCfg.model,
          temperature: roleCfg.temperature,
          maxTokens: roleCfg.maxTokens,
          signal,
        },
      );
      return res.content;
    },
  };
}

export function describeRole(cfg: AppConfig, role: Role): string {
  const r = cfg.roles[role];
  return `${r.provider}/${r.model}`;
}
