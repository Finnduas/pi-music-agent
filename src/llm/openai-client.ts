/** Minimal OpenAI-compatible chat client (OpenRouter, Ollama, any /v1 server). */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
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
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    return {
      content,
      model: json?.model ?? opts.model,
      usage: {
        promptTokens: json?.usage?.prompt_tokens,
        completionTokens: json?.usage?.completion_tokens,
      },
    };
  }
}
