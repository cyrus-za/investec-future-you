/**
 * Tiny OpenAI Chat Completions client (plain `fetch`, no SDK). Kept separate
 * so the tool-calling loop in ./coach.ts is easy to read and to stub in tests.
 */

export const OPENAI_MODEL = "gpt-4o-mini";
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 45_000;

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type OpenAIResponse = {
  model?: string;
  choices: {
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string;
  }[];
  usage?: OpenAIUsage;
};

export function readApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

export class OpenAIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function chatCompletion(
  apiKey: string,
  body: {
    messages: OpenAIMessage[];
    tools?: unknown[];
    tool_choice?: "auto" | "none";
    temperature?: number;
    max_tokens?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAIResponse> {
  const payload = JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 500,
    ...body,
  });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new OpenAIError(res.status, `OpenAI responded ${res.status}: ${text.slice(0, 300)}`);
        // Retry once on rate-limit / transient server errors only.
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as OpenAIResponse;
      if (!json.choices?.length) throw new OpenAIError(502, "OpenAI returned no choices.");
      return json;
    } catch (err) {
      if (err instanceof OpenAIError) throw err;
      lastErr = err;
      if (attempt === 0) continue; // network hiccup / abort: one retry
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI request failed.");
}
