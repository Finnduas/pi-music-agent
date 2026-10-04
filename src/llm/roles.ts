// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
import type { AppConfig, RoleConfig } from "../config.js";
import { OpenAICompatClient } from "./openai-client.js";
import type { ChatMessage } from "./openai-client.js";
import { executeTool, toolSpecs } from "../loop/tools.js";

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
    /** Native tool-calling path: the model can inspect/transpose the score and continue. */
    async completeWithTools(system: string, user: string, signal?: AbortSignal): Promise<string> {
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
        const tools = toolSpecs();
        for (let round = 0; round < 6; round++) {
          const res = await client.chat(messages, {
            model: roleCfg.model,
            temperature: roleCfg.temperature,
            maxTokens: roleCfg.maxTokens,
            tools,
            signal,
          });
          if (!res.toolCalls?.length) return res.content;
          messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
          for (const tc of res.toolCalls) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: executeTool(tc.name, tc.arguments),
            });
          }
        }
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        return last?.content ?? "";
      } catch {
        // Some providers reject native tools; fall back to a plain completion.
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
      }
    },
  };
}

export function describeRole(cfg: AppConfig, role: Role): string {
  const r = cfg.roles[role];
  return `${r.provider}/${r.model}`;
}
