// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Finnduas
/** Minimal OpenAI-compatible chat client (OpenRouter, Ollama, any /v1 server). */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  toolCalls?: ToolCall[];
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ToolSpec[];
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  toolCalls?: ToolCall[];
}

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class OpenAICompatClient {
  constructor(private cfg: ClientConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: false,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `LLM request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }
    const json: any = await res.json();
    const msg = json?.choices?.[0]?.message ?? {};
    const content: string = msg.content ?? "";
    const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? "{}",
        }))
      : undefined;
    return {
      content,
      model: json?.model ?? opts.model,
      usage: {
        promptTokens: json?.usage?.prompt_tokens,
        completionTokens: json?.usage?.completion_tokens,
      },
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}
