import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { createTestBackend } from "../test.setup";
import { MAX_TOOL_ROUNDS, NOT_CONFIGURED_MESSAGE } from "./coach";
import { OPENAI_URL, type OpenAIMessage } from "./openai";
import {
  buildContextBlock,
  CONTEXT_TOP_N,
  formatDay,
  formatMoney,
  monthlyEquivalentCents,
  parseIsoDay,
  SYSTEM_PROMPT,
  type ContextSeries,
} from "./prompt";
import {
  clampHorizon,
  formatAffordabilityResult,
  formatCancellationResult,
  formatForecastResult,
  formatRecurringResult,
  matchSeries,
  parseToolArgs,
  randToCents,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
} from "./tools";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 17, 10, 0, 0); // Thu 17 Sep 2026

type TestSeries = ContextSeries & { occurrenceCount?: number; amountVariance?: number };

function series(overrides: Partial<TestSeries> & { label: string }): TestSeries {
  return {
    direction: "debit",
    cadence: "monthly",
    typicalAmountCents: 10000,
    predictedNextAt: NOW + 5 * DAY,
    confidence: 0.9,
    isPayday: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// prompt.ts
// ---------------------------------------------------------------------------
describe("prompt helpers", () => {
  it("formats money and dates deterministically", () => {
    expect(formatMoney(1250000)).toBe("R12,500.00");
    expect(formatMoney(-123456)).toBe("-R1,234.56");
    expect(formatMoney(5)).toBe("R0.05");
    expect(formatMoney(100, "USD")).toBe("USD 1.00");
    expect(formatDay(NOW)).toBe("Thu 17 Sep 2026");
  });

  it("parses ISO days and clamps past dates to today", () => {
    expect(parseIsoDay("2026-10-15", NOW)).toBe(Date.UTC(2026, 9, 15));
    expect(parseIsoDay("2026-01-01", NOW)).toBe(NOW);
    expect(parseIsoDay("15 Oct", NOW)).toBeNull();
    expect(parseIsoDay(undefined, NOW)).toBeNull();
  });

  it("computes monthly equivalents per cadence", () => {
    expect(monthlyEquivalentCents("monthly", 19900)).toBe(19900);
    expect(monthlyEquivalentCents("weekly", 80000)).toBe(Math.round((80000 * 52) / 12));
    expect(monthlyEquivalentCents("irregular", 80000)).toBeNull();
  });

  it("system prompt encodes the honesty rules", () => {
    for (const phrase of ["not financial advice", "projected", "Never", "Next step:", "ZAR"]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("builds a compact context block with payday, projection and top-N recurring items", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      series({ label: `Merchant ${i}`, typicalAmountCents: (i + 1) * 1000 }),
    );
    const payday = series({
      label: "ACME CORP",
      direction: "credit",
      typicalAmountCents: 3800000,
      isPayday: true,
      predictedNextAt: NOW + 8 * DAY,
    });
    const irregular = series({ label: "TAKEALOT", cadence: "irregular" });
    const block = buildContextBlock({
      nowMs: NOW,
      forecast: {
        accountName: "Demo Everyday Account",
        currency: "ZAR",
        balanceAsOf: NOW - DAY,
        startingBalanceCents: 2345600,
        minBalanceCents: 120000,
        minBalanceAtMs: NOW + 6 * DAY,
        firstBreachAtMs: null,
        nextPaydayAtMs: NOW + 8 * DAY,
        daysUntilPayday: 8,
        dailyBalances: Array.from({ length: 31 }, (_, d) => ({ dateMs: NOW + d * DAY, balanceCents: 3000000 })),
      },
      series: [...many, payday, irregular],
    });

    expect(block).toContain("Today: Thu 17 Sep 2026 (2026-09-17)");
    expect(block).toContain("Account: Demo Everyday Account (ZAR)");
    expect(block).toContain("Balance the forecast starts from: R23,456.00");
    expect(block).toContain("Next projected payday: Fri 25 Sep 2026 (in 8 days), typically R38,000.00 from ACME CORP");
    expect(block).toContain("30-day projection: lowest R1,200.00 on Wed 23 Sep 2026; ends at R30,000.00; first dip to/below R0.00: none");
    expect(block).toContain(`Top ${CONTEXT_TOP_N} recurring items`);
    // Largest first, capped at CONTEXT_TOP_N (payday is the largest).
    expect(block).toContain("1. ACME CORP: +R38,000.00 monthly");
    expect(block).not.toContain("Merchant 0:");
    expect(block).toContain("1 other merchant recur");
    expect(block).toContain("Assumptions:");
    // Cheap: well under ~2k characters so it fits in every request.
    expect(block.length).toBeLessThan(2000);
  });

  it("explains the empty state when nothing is synced", () => {
    const block = buildContextBlock({ nowMs: NOW, forecast: null, series: [] });
    expect(block).toContain("No account data is available yet");
  });
});

// ---------------------------------------------------------------------------
// tools.ts (pure parts)
// ---------------------------------------------------------------------------
describe("tool schema and argument parsing", () => {
  it("exposes exactly the documented tools with valid JSON-schema parameters", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual([...TOOL_NAMES]);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(t.function.description.length).toBeGreaterThan(40);
      expect(t.function.parameters.type).toBe("object");
    }
    const afford = TOOL_DEFINITIONS.find((t) => t.function.name === "check_affordability")!;
    const params = afford.function.parameters as { required?: string[] };
    expect(params.required).toEqual(["amount_rand"]);
  });

  it("parses tool arguments defensively", () => {
    expect(parseToolArgs('{"amount_rand": 4500}')).toEqual({ amount_rand: 4500 });
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs("[1,2]")).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });

  it("converts rand to cents and clamps horizons", () => {
    expect(randToCents(4500)).toBe(450000);
    expect(randToCents("R4 500,00".replace(",00", ".00"))).toBe(450000);
    expect(randToCents(-5)).toBeNull();
    expect(randToCents("abc")).toBeNull();
    expect(clampHorizon(undefined)).toBe(30);
    expect(clampHorizon(3)).toBe(7);
    expect(clampHorizon(365)).toBe(90);
  });

  it("matches a recurring series by merchant name, preferring debits", () => {
    const rows = [
      { label: "NETFLIX.COM", merchantKey: "NETFLIX", direction: "debit" as const },
      { label: "NETFLIX REFUND", merchantKey: "NETFLIX REFUND", direction: "credit" as const },
      { label: "SPOTIFY", merchantKey: "SPOTIFY", direction: "debit" as const },
    ];
    expect(matchSeries(rows, "netflix")?.label).toBe("NETFLIX.COM");
    expect(matchSeries(rows, "Cancel Spotify")?.label).toBe("SPOTIFY");
    expect(matchSeries(rows, "showmax")).toBeNull();
  });
});

describe("tool result formatting", () => {
  const dailyBalances = Array.from({ length: 31 }, (_, d) => ({ dateMs: NOW + d * DAY, balanceCents: 1000000 - d * 10000 }));
  const forecast = {
    currency: "ZAR",
    dailyBalances,
    events: Array.from({ length: 20 }, (_, i) => ({
      dateMs: NOW + i * DAY,
      merchantKey: `M${i}`,
      label: `Merchant ${i}`,
      direction: "debit" as const,
      amountCents: -10000,
      confidence: 0.8,
      isPayday: false,
    })),
    startingBalanceCents: 1000000,
    minBalanceCents: 700000,
    minBalanceAtMs: NOW + 30 * DAY,
    firstBreachAtMs: null,
    nextPaydayAtMs: NOW + 8 * DAY,
    daysUntilPayday: 8,
    safeToSpendCents: 700000,
    runwayDays: null,
    bands: { expected: dailyBalances, optimistic: dailyBalances, pessimistic: dailyBalances },
  };

  it("collapses a forecast to human-formatted checkpoints (no raw cents, no 31-day array)", () => {
    const out = formatForecastResult(forecast, 0);
    expect(out.starting_balance).toBe("R10,000.00");
    expect(out.projected_lowest_balance).toBe("R7,000.00");
    expect(out.projected_end_balance).toBe("R7,000.00");
    expect(out.first_dip_to_or_below_threshold).toBeNull();
    expect(out.next_projected_payday).toBe("Fri 25 Sep 2026");
    expect(out.weekly_checkpoints.map((c) => c.projected_balance)).toEqual([
      "R10,000.00",
      "R9,300.00",
      "R8,600.00",
      "R7,900.00",
      "R7,200.00",
      "R7,000.00",
    ]);
    expect(out.upcoming_events).toHaveLength(14);
    expect(out.events_omitted).toBe(6);
    expect(JSON.stringify(out)).not.toContain("dailyBalances");
    expect(out.note).toMatch(/NOT included/);
  });

  it("formats an affordability verdict with the purchase echoed back", () => {
    const out = formatAffordabilityResult(
      {
        currency: "ZAR",
        canAfford: false,
        baselineMinBalanceCents: 120000,
        projectedMinBalanceCents: -330000,
        projectedMinBalanceAtMs: NOW + 20 * DAY,
        firstBreachAtMs: NOW + 18 * DAY,
        daysUntilPayday: 8,
      },
      { label: "Flight", amountCents: 450000, dateMs: Date.UTC(2026, 9, 15) },
    );
    expect(out.purchase).toEqual({ label: "Flight", amount: "R4,500.00", date: "Thu 15 Oct 2026" });
    expect(out.verdict).toMatch(/to\/below the safety threshold/);
    expect(out.projected_lowest_balance_with_purchase).toBe("-R3,300.00");
    expect(out.projected_lowest_balance_without_purchase).toBe("R1,200.00");
    expect(out.first_dip_to_or_below_threshold_with_purchase).toBe("Mon 5 Oct 2026");
  });

  it("lists recurring items largest-first with monthly equivalents and a total", () => {
    const out = formatRecurringResult(
      [
        series({ label: "SPOTIFY", typicalAmountCents: 9900 }),
        series({ label: "RENT", typicalAmountCents: 1250000, occurrenceCount: 6 }),
        series({ label: "WOOLWORTHS", cadence: "weekly", typicalAmountCents: 80000, amountVariance: 0.3 }),
        series({ label: "TAKEALOT", cadence: "irregular" }),
        series({ label: "ACME", direction: "credit", typicalAmountCents: 3800000, isPayday: true }),
      ],
      "ZAR",
      "debit",
    );
    expect(out.items.map((i) => i.label)).toEqual(["RENT", "WOOLWORTHS", "SPOTIFY"]);
    expect(out.items[1]).toMatchObject({ cadence: "weekly", approx_monthly_equivalent: "R3,466.67", amount_varies: true });
    expect(out.items[0]).toMatchObject({ times_seen: 6 });
    expect(out.approx_total_monthly_recurring_payments).toBe("R16,065.67");
    expect(out.irregular_merchants_not_forecast).toEqual(["TAKEALOT"]);
  });

  it("describes a cancellation what-if, or lists candidates when nothing matches", () => {
    const before = { ...forecast, events: forecast.events.slice(0, 5) };
    const after = { ...forecast, events: forecast.events.slice(0, 4), minBalanceCents: 719900 };
    const matched = { ...series({ label: "NETFLIX.COM", typicalAmountCents: 19900 }) };
    const out = formatCancellationResult({ currency: "ZAR", query: "netflix", matched, before, after, candidates: [] });
    expect(out).toMatchObject({
      matched: "NETFLIX.COM",
      estimated_monthly_saving: "R199.00",
      estimated_yearly_saving: "R2,388.00",
      occurrences_removed_in_horizon: 1,
      projected_lowest_balance_after: "R7,199.00",
    });
    const miss = formatCancellationResult({ currency: "ZAR", query: "showmax", matched: null, before: null, after: null, candidates: ["NETFLIX.COM"] });
    expect(miss.matched).toBeNull();
    expect(miss.detected_payments).toEqual(["NETFLIX.COM"]);
  });
});

// ---------------------------------------------------------------------------
// messages.ts
// ---------------------------------------------------------------------------
describe("chat message persistence", () => {
  it("lists messages oldest-first per thread and clears a thread", async () => {
    const t = createTestBackend();
    expect(await t.query(api.chat.messages.listMessages, { threadId: "t1" })).toEqual([]);

    await t.mutation(internal.chat.messages.append, { threadId: "t1", role: "user", content: "hi" });
    await t.mutation(internal.chat.messages.append, {
      threadId: "t1",
      role: "assistant",
      content: "hello",
      meta: { toolCalls: [] },
    });
    await t.mutation(internal.chat.messages.append, { threadId: "t2", role: "user", content: "other thread" });

    const list = await t.query(api.chat.messages.listMessages, { threadId: "t1" });
    expect(list.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(list[1].meta).toEqual({ toolCalls: [] });

    const recent = await t.query(internal.chat.messages.recent, { threadId: "t1", limit: 1 });
    expect(recent).toEqual([{ role: "assistant", content: "hello" }]);

    expect(await t.mutation(api.chat.messages.clearThread, { threadId: "t1" })).toEqual({ deleted: 2 });
    expect(await t.query(api.chat.messages.listMessages, { threadId: "t1" })).toEqual([]);
    expect(await t.query(api.chat.messages.listMessages, { threadId: "t2" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// coach.ts / status.ts (action loop with a stubbed OpenAI)
// ---------------------------------------------------------------------------
type Captured = { url: string; body: any };

function scriptedFetch(responses: unknown[], captured: Captured[]) {
  let i = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function assistantToolCall(name: string, args: Record<string, unknown>, id = "call_1") {
  return {
    model: "gpt-4o-mini",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function assistantText(content: string) {
  return {
    model: "gpt-4o-mini",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
  };
}

describe("sendMessage action", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test-not-real";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("reports enabled/disabled based on OPENAI_API_KEY without leaking it", async () => {
    const t = createTestBackend();
    const on = await t.action(api.chat.status.isEnabled, {});
    expect(on).toMatchObject({ enabled: true, model: "gpt-4o-mini", reason: null });
    expect(JSON.stringify(on)).not.toContain("sk-test");

    delete process.env.OPENAI_API_KEY;
    const off = await t.action(api.chat.status.isEnabled, {});
    expect(off.enabled).toBe(false);
    expect(off.reason).toMatch(/OPENAI_API_KEY/);
  });

  it("fails fast with a clear error when the key is missing and persists nothing", async () => {
    delete process.env.OPENAI_API_KEY;
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    await expect(
      t.action(api.chat.coach.sendMessage, { threadId: "t-nokey", accountId, message: "hi" }),
    ).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
    expect(await t.query(api.chat.messages.listMessages, { threadId: "t-nokey" })).toEqual([]);
  });

  it("runs one tool round-trip end to end using real forecast numbers", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});

    const nextMonth15 = new Date(Date.now());
    nextMonth15.setUTCMonth(nextMonth15.getUTCMonth() + 1, 15);
    const isoDate = nextMonth15.toISOString().slice(0, 10);

    const captured: Captured[] = [];
    const fetchMock = scriptedFetch(
      [
        assistantToolCall("check_affordability", { amount_rand: 4500, date: isoDate, label: "Flight" }),
        assistantText("- Projected lowest balance after the flight: see figures.\nNext step: re-check after payday."),
      ],
      captured,
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await t.action(api.chat.coach.sendMessage, {
      threadId: "t-e2e",
      accountId,
      message: "Can I afford a R4,500 flight on the 15th?",
    });

    // Two OpenAI calls: one that requested the tool, one that answered.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captured.every((c) => c.url === OPENAI_URL)).toBe(true);

    const first = captured[0].body;
    expect(first.model).toBe("gpt-4o-mini");
    expect(first.temperature).toBe(0.2);
    expect(first.tools.map((x: any) => x.function.name)).toEqual([...TOOL_NAMES]);
    const roles = first.messages.map((m: OpenAIMessage) => m.role);
    expect(roles.slice(0, 2)).toEqual(["system", "system"]);
    expect(first.messages[1].content).toContain("ACCOUNT CONTEXT");
    expect(first.messages[1].content).toContain("Demo Everyday Account");
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "Can I afford a R4,500 flight on the 15th?" });

    // The second request carries the tool result — and it must match what
    // the deterministic query itself returns for the same inputs.
    const second = captured[1].body;
    const toolMsg = second.messages.find((m: OpenAIMessage) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    const toolResult = JSON.parse(toolMsg.content);
    const truth = await t.query(api.forecast.queries.checkAffordability, {
      accountId,
      amountCents: 450000,
      dateMs: Date.UTC(nextMonth15.getUTCFullYear(), nextMonth15.getUTCMonth(), 15),
      label: "Flight",
      safetyThresholdCents: 0,
    });
    expect(toolResult.purchase).toEqual({ label: "Flight", amount: "R4,500.00", date: formatDay(Date.UTC(nextMonth15.getUTCFullYear(), nextMonth15.getUTCMonth(), 15)) });
    expect(toolResult.projected_lowest_balance_with_purchase).toBe(formatMoney(truth!.projectedMinBalanceCents));
    expect(toolResult.projected_lowest_balance_without_purchase).toBe(formatMoney(truth!.baselineMinBalanceCents));
    expect(toolResult.verdict).toBe(
      truth!.canAfford
        ? "projected to stay above the safety threshold"
        : "projected to push the balance to/below the safety threshold before the horizon ends",
    );

    // Reply + transparency metadata.
    expect(res.reply).toContain("Next step:");
    expect(res.model).toBe("gpt-4o-mini");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({ name: "check_affordability", ok: true, args: { amount_rand: 4500 } });
    expect(res.toolCalls[0].summary).toContain("R4,500.00");

    const persisted = await t.query(api.chat.messages.listMessages, { threadId: "t-e2e" });
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted[1].content).toBe(res.reply);
    expect(persisted[1].meta).toMatchObject({
      model: "gpt-4o-mini",
      rounds: 2,
      usage: { prompt: 250, completion: 60 },
      toolCalls: [{ name: "check_affordability", ok: true }],
    });
  });

  it("stops after MAX_TOOL_ROUNDS and forces a final answer with tools disabled", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const captured: Captured[] = [];
    // Always ask for another tool call; the loop must cap it.
    const fetchMock = scriptedFetch([assistantToolCall("get_forecast", { horizon_days: 30 })], captured);
    vi.stubGlobal("fetch", fetchMock);

    const res = await t.action(api.chat.coach.sendMessage, { threadId: "t-loop", accountId, message: "Will I make it to payday?" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(captured.at(-1)!.body.tool_choice).toBe("none");
    expect(captured.slice(0, -1).every((c) => c.body.tool_choice === "auto")).toBe(true);
    expect(res.toolCalls).toHaveLength(MAX_TOOL_ROUNDS);
    // The forced round returned no content (our stub still answered with a
    // tool call), so the user gets the honest fallback rather than nothing.
    expect(res.reply).toMatch(/couldn't put together an answer/);
  });

  it("keeps earlier turns of the thread as conversation memory", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    await t.mutation(internal.chat.messages.append, { threadId: "t-mem", accountId, role: "user", content: "earlier question" });
    await t.mutation(internal.chat.messages.append, { threadId: "t-mem", accountId, role: "assistant", content: "earlier answer" });
    const captured: Captured[] = [];
    vi.stubGlobal("fetch", scriptedFetch([assistantText("ok")], captured));

    await t.action(api.chat.coach.sendMessage, { threadId: "t-mem", accountId, message: "follow-up" });
    const convo = captured[0].body.messages.filter((m: OpenAIMessage) => m.role !== "system");
    expect(convo).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "follow-up" },
    ]);
  });

  it("translates OpenAI failures into friendly errors", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid api key", { status: 401 })),
    );
    await expect(
      t.action(api.chat.coach.sendMessage, { threadId: "t-401", accountId, message: "hi" }),
    ).rejects.toThrow(/API key was rejected/);
  });
});
