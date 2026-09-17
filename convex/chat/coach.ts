import { ConvexError, v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { chatCompletion, OPENAI_MODEL, OpenAIError, readApiKey, type OpenAIMessage, type OpenAIToolCall } from "./openai";
import { buildContextBlock, SYSTEM_PROMPT } from "./prompt";
import { executeTool, parseToolArgs, TOOL_DEFINITIONS, type ToolExecution } from "./tools";

export const MAX_TOOL_ROUNDS = 4;
export const HISTORY_TURNS = 12;
export const MAX_MESSAGE_CHARS = 2000;
const CONTEXT_HORIZON_DAYS = 30;

export const NOT_CONFIGURED_MESSAGE =
  "AI coach not configured: OPENAI_API_KEY is not set on the Convex deployment.";

const toolCallSummaryValidator = v.object({
  name: v.string(),
  args: v.any(),
  summary: v.string(),
  ok: v.boolean(),
});

/**
 * "Chat with Future You". One call = one user turn:
 *  1. persist the user message,
 *  2. build a compact deterministic context block from the forecast engine,
 *  3. let the model answer, calling forecast tools as needed (bounded loop),
 *  4. persist the assistant reply + which tools were used (transparency).
 *
 * The model never sees raw transactions and never computes money itself —
 * every figure comes from the same queries that power the dashboard.
 */
export const sendMessage = action({
  args: {
    threadId: v.string(),
    accountId: v.id("accounts"),
    message: v.string(),
    safetyThresholdCents: v.optional(v.number()),
  },
  returns: v.object({
    reply: v.string(),
    toolCalls: v.array(toolCallSummaryValidator),
    model: v.string(),
  }),
  handler: async (ctx, args) => {
    const apiKey = readApiKey();
    if (!apiKey) throw new ConvexError(NOT_CONFIGURED_MESSAGE);

    const message = args.message.trim();
    if (!message) throw new ConvexError("Please type a question first.");
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new ConvexError(`Please keep questions under ${MAX_MESSAGE_CHARS} characters.`);
    }
    const threshold = args.safetyThresholdCents ?? 0;
    const nowMs = Date.now();

    await ctx.runMutation(internal.chat.messages.append, {
      threadId: args.threadId,
      accountId: args.accountId,
      role: "user",
      content: message,
    });

    // Deterministic context + recent history, fetched together.
    const history: { role: "user" | "assistant"; content: string }[] = await ctx.runQuery(
      internal.chat.messages.recent,
      { threadId: args.threadId, limit: HISTORY_TURNS },
    );
    const forecast = await ctx.runQuery(api.forecast.queries.getForecast, {
      accountId: args.accountId,
      horizonDays: CONTEXT_HORIZON_DAYS,
      safetyThresholdCents: threshold,
    });
    const series: Doc<"recurringSeries">[] = await ctx.runQuery(api.forecast.queries.listRecurringSeries, {
      accountId: args.accountId,
    });
    const contextBlock = buildContextBlock({ nowMs, forecast, series, safetyThresholdCents: threshold });

    const messages: OpenAIMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: contextBlock },
      ...history.map((m) => ({ role: m.role, content: m.content }) as OpenAIMessage),
    ];
    // `recent` already includes the user message we just persisted; if the
    // read raced ahead of the write for some reason, make sure it's there.
    if (history.length === 0 || history[history.length - 1].content !== message) {
      messages.push({ role: "user", content: message });
    }

    const { reply, toolCalls, usage, rounds } = await runToolLoop(ctx, apiKey, messages, {
      accountId: args.accountId,
      nowMs,
      safetyThresholdCents: threshold,
    });

    await ctx.runMutation(internal.chat.messages.append, {
      threadId: args.threadId,
      accountId: args.accountId,
      role: "assistant",
      content: reply,
      meta: {
        model: OPENAI_MODEL,
        toolCalls: toolCalls.map(({ name, args: a, summary, ok }) => ({ name, args: a, summary, ok })),
        rounds,
        usage,
        contextChars: contextBlock.length,
      },
    });

    return {
      reply,
      toolCalls: toolCalls.map(({ name, args: a, summary, ok }) => ({ name, args: a, summary, ok })),
      model: OPENAI_MODEL,
    };
  },
});

/**
 * Bounded tool-calling loop: up to MAX_TOOL_ROUNDS rounds of tool calls, then
 * one final forced-answer round with tools disabled so the user always gets
 * a reply.
 */
export async function runToolLoop(
  ctx: ActionCtx,
  apiKey: string,
  messages: OpenAIMessage[],
  opts: { accountId: Id<"accounts">; nowMs: number; safetyThresholdCents: number },
): Promise<{ reply: string; toolCalls: ToolExecution[]; usage: { prompt: number; completion: number }; rounds: number }> {
  const toolCalls: ToolExecution[] = [];
  const usage = { prompt: 0, completion: 0 };
  let rounds = 0;
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const forceAnswer = round === MAX_TOOL_ROUNDS;
      const res = await chatCompletion(apiKey, {
        messages,
        tools: [...TOOL_DEFINITIONS],
        tool_choice: forceAnswer ? "none" : "auto",
      });
      rounds++;
      usage.prompt += res.usage?.prompt_tokens ?? 0;
      usage.completion += res.usage?.completion_tokens ?? 0;
      const choice = res.choices[0].message;
      const calls: OpenAIToolCall[] = choice.tool_calls ?? [];

      if (calls.length === 0 || forceAnswer) {
        const reply = (choice.content ?? "").trim();
        return {
          reply: reply || "I couldn't put together an answer from the forecast data for that. Try rephrasing, or ask about payday, a specific purchase, or your recurring payments.",
          toolCalls,
          usage,
          rounds,
        };
      }

      messages.push({ role: "assistant", content: choice.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const exec = await executeTool(ctx, opts.accountId, call.function.name, parseToolArgs(call.function.arguments), {
          nowMs: opts.nowMs,
          safetyThresholdCents: opts.safetyThresholdCents,
        });
        toolCalls.push(exec);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(exec.result) });
      }
    }
    // Unreachable: the forceAnswer round always returns.
    throw new Error("Tool loop exited unexpectedly.");
  } catch (err) {
    if (err instanceof ConvexError) throw err;
    if (err instanceof OpenAIError) {
      if (err.status === 401) throw new ConvexError("AI coach not configured: the OpenAI API key was rejected.");
      if (err.status === 429) throw new ConvexError("The AI coach is rate-limited right now. Please try again in a moment.");
      throw new ConvexError("The AI coach couldn't reach OpenAI. Your forecast is unaffected — please try again.");
    }
    throw new ConvexError(
      `The AI coach hit an unexpected error (${err instanceof Error ? err.message : String(err)}). Your forecast is unaffected.`,
    );
  }
}
