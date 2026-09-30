/**
 * Tools the coach can call. Each tool is a thin wrapper around the app's
 * deterministic forecast queries — the model never computes money itself,
 * it only asks these tools and quotes what comes back.
 *
 * The `format*` functions are pure (unit-tested) and deliberately return
 * small, human-formatted objects: amounts are pre-rendered as "R1,250.00"
 * strings so the model cannot mis-convert cents, and long arrays (31 daily
 * balances) are collapsed to a handful of checkpoints to keep tokens low.
 */
import { makeFunctionReference } from "convex/server";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { runForecast, type ForecastResult, type ForecastSeriesInput } from "../forecast/engine";
import {
  cadenceWord,
  formatDay,
  formatMoney,
  formatPercent,
  monthlyEquivalentCents,
  parseIsoDay,
  toIsoDay,
} from "./prompt";

export const TOOL_NAMES = [
  "get_forecast",
  "check_affordability",
  "list_recurring",
  "simulate_cancellation",
  "list_insights",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** OpenAI Chat Completions `tools` payload. */
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_forecast",
      description:
        "Project the account balance day-by-day from today using the detected recurring payments and income. Returns the lowest projected balance and its date, the first date the balance dips to/below the safety threshold (if any), the next projected payday, weekly balance checkpoints and the upcoming recurring events.",
      parameters: {
        type: "object",
        properties: {
          horizon_days: {
            type: "integer",
            description: "How many days ahead to project (7-90). Default 30.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_affordability",
      description:
        "Re-run the balance projection with one extra hypothetical purchase and report whether it is projected to push the balance below the safety threshold before the horizon ends. Use for any 'can I afford X' question.",
      parameters: {
        type: "object",
        properties: {
          amount_rand: {
            type: "number",
            description: "Cost of the purchase in rand (e.g. 4500 for R4,500).",
          },
          date: {
            type: "string",
            description:
              "Purchase date as YYYY-MM-DD. Defaults to today. Never earlier than today.",
          },
          label: { type: "string", description: "Short name for the purchase, e.g. 'Flight to CPT'." },
        },
        required: ["amount_rand"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recurring",
      description:
        "List the recurring payments and income detected in the synced transaction history (subscriptions, debit orders, salary), with cadence, typical amount, next expected date and detection confidence. Sorted by typical amount, largest first.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["debit", "credit", "all"],
            description: "Only outgoing (debit), only incoming (credit), or all. Default all.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_cancellation",
      description:
        "What-if: remove one recurring payment (matched by merchant name, e.g. 'Netflix') from the projection and report the estimated monthly saving and the change in the projected lowest and end-of-horizon balances. Purely hypothetical; it does not cancel anything.",
      parameters: {
        type: "object",
        properties: {
          merchant: { type: "string", description: "Merchant / description to match, case-insensitive." },
          horizon_days: { type: "integer", description: "Projection horizon in days (7-90). Default 30." },
        },
        required: ["merchant"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_insights",
      description:
        "List proactive alerts for this account (cashflow risk, unusual amount changes, missed debit orders) plus any anomaly flags on recurring payments.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
] as const;

export function parseToolArgs(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function clampHorizon(value: unknown, fallback = 30): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(90, Math.max(7, n));
}

/** Rand (number or "R4 500,00"-ish string) -> positive integer cents, or null. */
export function randToCents(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const cleaned = value.replace(/[Rr\s,]/g, "");
    n = cleaned ? Number(cleaned) : null;
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------------------
// Pure result formatters
// ---------------------------------------------------------------------------

type ForecastLike = ForecastResult & { currency: string };

export function formatForecastResult(f: ForecastLike, safetyThresholdCents = 0) {
  const cur = f.currency;
  const money = (c: number) => formatMoney(c, cur);
  const horizonDays = Math.max(0, f.dailyBalances.length - 1);
  const checkpointDays = [0, 7, 14, 21, 28, horizonDays].filter(
    (d, i, arr) => d <= horizonDays && arr.indexOf(d) === i,
  );
  const checkpoints = checkpointDays
    .map((d) => f.dailyBalances[d])
    .filter(Boolean)
    .map((b) => ({ date: formatDay(b.dateMs), projected_balance: money(b.balanceCents) }));
  const endBalance = f.dailyBalances[f.dailyBalances.length - 1]?.balanceCents ?? f.startingBalanceCents;
  return {
    horizon_days: horizonDays,
    starting_balance: money(f.startingBalanceCents),
    projected_end_balance: money(endBalance),
    projected_lowest_balance: money(f.minBalanceCents),
    projected_lowest_balance_date: formatDay(f.minBalanceAtMs),
    safety_threshold: money(safetyThresholdCents),
    first_dip_to_or_below_threshold: f.firstBreachAtMs === null ? null : formatDay(f.firstBreachAtMs),
    next_projected_payday: f.nextPaydayAtMs === null ? null : formatDay(f.nextPaydayAtMs),
    days_until_payday: f.daysUntilPayday,
    weekly_checkpoints: checkpoints,
    upcoming_events: f.events.slice(0, 14).map((e) => ({
      date: formatDay(e.dateMs),
      label: e.label,
      amount: money(e.amountCents),
      confidence: formatPercent(e.confidence),
      ...(e.isPayday ? { is_payday: true } : {}),
    })),
    events_omitted: Math.max(0, f.events.length - 14),
    note: "Projection assumes each detected recurring item repeats exactly as before. One-off spending, pending card holds and interest are NOT included.",
  };
}

type AffordabilityLike = {
  currency: string;
  canAfford: boolean;
  baselineMinBalanceCents: number;
  projectedMinBalanceCents: number;
  projectedMinBalanceAtMs: number;
  firstBreachAtMs: number | null;
  daysUntilPayday: number | null;
};

export function formatAffordabilityResult(
  r: AffordabilityLike,
  purchase: { label: string; amountCents: number; dateMs: number },
  safetyThresholdCents = 0,
) {
  const money = (c: number) => formatMoney(c, r.currency);
  return {
    purchase: { label: purchase.label, amount: money(purchase.amountCents), date: formatDay(purchase.dateMs) },
    verdict: r.canAfford
      ? "projected to stay above the safety threshold"
      : "projected to push the balance to/below the safety threshold before the horizon ends",
    safety_threshold: money(safetyThresholdCents),
    projected_lowest_balance_with_purchase: money(r.projectedMinBalanceCents),
    projected_lowest_balance_date: formatDay(r.projectedMinBalanceAtMs),
    projected_lowest_balance_without_purchase: money(r.baselineMinBalanceCents),
    first_dip_to_or_below_threshold_with_purchase:
      r.firstBreachAtMs === null ? null : formatDay(r.firstBreachAtMs),
    days_until_payday: r.daysUntilPayday,
    note: "Same projection as the dashboard's 'Can I afford this?' calculator: detected recurring items only; one-off spending is not modelled.",
  };
}

type SeriesLike = {
  label: string;
  direction: "debit" | "credit";
  cadence: string;
  typicalAmountCents: number;
  amountVariance?: number;
  occurrenceCount?: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
  category?: string;
  anomalyKind?: string;
  anomalyDetail?: string;
};

export function formatRecurringResult(series: SeriesLike[], currency: string, direction: unknown) {
  const dir = direction === "debit" || direction === "credit" ? direction : "all";
  const filtered = series.filter((s) => dir === "all" || s.direction === dir);
  const forecastable = filtered.filter((s) => s.cadence !== "irregular");
  const irregular = filtered.filter((s) => s.cadence === "irregular");
  const money = (c: number) => formatMoney(c, currency);
  const items = forecastable
    .slice()
    .sort((a, b) => b.typicalAmountCents - a.typicalAmountCents)
    .slice(0, 25)
    .map((s) => {
      const monthly = monthlyEquivalentCents(s.cadence, s.typicalAmountCents);
      return {
        label: s.label,
        direction: s.direction === "credit" ? "income" : "payment",
        cadence: cadenceWord(s.cadence),
        typical_amount: money(s.typicalAmountCents),
        ...(monthly !== null && s.cadence !== "monthly" ? { approx_monthly_equivalent: money(monthly) } : {}),
        next_expected: formatDay(s.predictedNextAt),
        confidence: formatPercent(s.confidence),
        ...(s.occurrenceCount !== undefined ? { times_seen: s.occurrenceCount } : {}),
        ...(s.amountVariance !== undefined && s.amountVariance > 0.1 ? { amount_varies: true } : {}),
        ...(s.isPayday ? { is_payday: true } : {}),
        ...(s.category ? { category: s.category } : {}),
        ...(s.anomalyKind ? { anomaly: `${s.anomalyKind}${s.anomalyDetail ? `: ${s.anomalyDetail}` : ""}` } : {}),
      };
    });
  const monthlyDebitTotal = forecastable
    .filter((s) => s.direction === "debit")
    .reduce((sum, s) => sum + (monthlyEquivalentCents(s.cadence, s.typicalAmountCents) ?? 0), 0);
  return {
    count: items.length,
    items,
    ...(dir !== "credit" ? { approx_total_monthly_recurring_payments: money(monthlyDebitTotal) } : {}),
    irregular_merchants_not_forecast: irregular.slice(0, 10).map((s) => s.label),
    note: "Detected from 2+ occurrences of the same merchant. Confidence is a heuristic (0-100%) based on how many times it was seen and how steady the interval and amount are.",
  };
}

export function formatCancellationResult(input: {
  currency: string;
  query: string;
  matched: SeriesLike | null;
  before: ForecastResult | null;
  after: ForecastResult | null;
  candidates: string[];
}) {
  const money = (c: number) => formatMoney(c, input.currency);
  if (!input.matched || !input.before || !input.after) {
    return {
      matched: null,
      message: `No recurring payment matching "${input.query}" was found in the detected recurring items.`,
      detected_payments: input.candidates.slice(0, 15),
    };
  }
  const s = input.matched;
  const monthly = monthlyEquivalentCents(s.cadence, s.typicalAmountCents);
  const endBefore = input.before.dailyBalances.at(-1)?.balanceCents ?? input.before.startingBalanceCents;
  const endAfter = input.after.dailyBalances.at(-1)?.balanceCents ?? input.after.startingBalanceCents;
  return {
    matched: s.label,
    cadence: cadenceWord(s.cadence),
    typical_amount: money(s.typicalAmountCents),
    estimated_monthly_saving: monthly === null ? null : money(monthly),
    estimated_yearly_saving: monthly === null ? null : money(monthly * 12),
    occurrences_removed_in_horizon: input.before.events.length - input.after.events.length,
    projected_lowest_balance_before: money(input.before.minBalanceCents),
    projected_lowest_balance_after: money(input.after.minBalanceCents),
    projected_end_balance_before: money(endBefore),
    projected_end_balance_after: money(endAfter),
    note:
      s.cadence === "irregular"
        ? "This merchant recurs irregularly so it was never part of the forecast; only the historical typical amount is known."
        : "Hypothetical only — nothing was cancelled. Savings assume the payment would otherwise have continued at its typical amount.",
  };
}

// ---------------------------------------------------------------------------
// Executor (needs an ActionCtx to call the deterministic queries)
// ---------------------------------------------------------------------------

export type ToolExecution = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** One-line human summary shown in the UI's transparency toggle. */
  summary: string;
  ok: boolean;
};

// The insights module is owned by another feature and may not exist at
// deploy time; reference it by name so this file compiles regardless and
// fall back gracefully at runtime.
const INSIGHT_CANDIDATES = ["insights:list", "insights/queries:list"].map((name) =>
  makeFunctionReference<"query", { accountId?: Id<"accounts"> }, unknown>(name),
);

export async function executeTool(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  name: string,
  args: Record<string, unknown>,
  opts: { nowMs?: number; safetyThresholdCents?: number } = {},
): Promise<ToolExecution> {
  const nowMs = opts.nowMs ?? Date.now();
  const threshold = opts.safetyThresholdCents ?? 0;
  try {
    switch (name as ToolName) {
      case "get_forecast": {
        const horizonDays = clampHorizon(args.horizon_days);
        const f = await ctx.runQuery(api.forecast.queries.getForecast, {
          accountId,
          horizonDays,
          safetyThresholdCents: threshold,
        });
        if (!f) return fail(name, args, "No account data available yet.");
        const result = formatForecastResult(f, threshold);
        return {
          name,
          args,
          result,
          ok: true,
          summary: `${horizonDays}-day forecast: lowest ${result.projected_lowest_balance} on ${result.projected_lowest_balance_date}`,
        };
      }
      case "check_affordability": {
        const amountCents = randToCents(args.amount_rand);
        if (amountCents === null) return fail(name, args, "amount_rand must be a positive number of rand.");
        const dateMs = parseIsoDay(args.date, nowMs) ?? nowMs;
        const label = typeof args.label === "string" && args.label.trim() ? args.label.trim() : "Hypothetical purchase";
        const r = await ctx.runQuery(api.forecast.queries.checkAffordability, {
          accountId,
          amountCents,
          dateMs,
          label,
          safetyThresholdCents: threshold,
        });
        if (!r) return fail(name, args, "No account data available yet.");
        const result = formatAffordabilityResult(r, { label, amountCents, dateMs }, threshold);
        return {
          name,
          args,
          result,
          ok: true,
          summary: `${label} (${result.purchase.amount} on ${toIsoDay(dateMs)}): ${
            r.canAfford ? "projected affordable" : "projected shortfall"
          }, lowest ${result.projected_lowest_balance_with_purchase}`,
        };
      }
      case "list_recurring": {
        const [series, currency]: [Doc<"recurringSeries">[], string] = await Promise.all([
          ctx.runQuery(api.forecast.queries.listRecurringSeries, { accountId }),
          currencyOf(ctx, accountId),
        ]);
        const result = formatRecurringResult(series, currency, args.direction);
        return { name, args, result, ok: true, summary: `${result.count} recurring items listed` };
      }
      case "simulate_cancellation": {
        const query = typeof args.merchant === "string" ? args.merchant.trim() : "";
        if (!query) return fail(name, args, "merchant is required.");
        const horizonDays = clampHorizon(args.horizon_days);
        const series: Doc<"recurringSeries">[] = await ctx.runQuery(api.forecast.queries.listRecurringSeries, {
          accountId,
        });
        const forecast = await ctx.runQuery(api.forecast.queries.getForecast, {
          accountId,
          horizonDays,
          safetyThresholdCents: threshold,
        });
        if (!forecast) return fail(name, args, "No account data available yet.");
        const matched = matchSeries(series, query);
        const inputs: ForecastSeriesInput[] = series.map((s) => ({
          merchantKey: s.merchantKey,
          label: s.label,
          direction: s.direction,
          cadence: s.cadence,
          typicalAmountCents: s.typicalAmountCents,
          intervalDays: s.intervalDays,
          predictedNextAt: s.predictedNextAt,
          confidence: s.confidence,
          isPayday: s.isPayday,
        }));
        const before = matched
          ? runForecast({ currentBalanceCents: forecast.startingBalanceCents, series: inputs, horizonDays, asOfMs: nowMs, safetyThresholdCents: threshold })
          : null;
        const after = matched
          ? runForecast({
              currentBalanceCents: forecast.startingBalanceCents,
              series: inputs.filter((s) => s.merchantKey !== matched.merchantKey),
              horizonDays,
              asOfMs: nowMs,
              safetyThresholdCents: threshold,
            })
          : null;
        const result = formatCancellationResult({
          currency: forecast.currency,
          query,
          matched,
          before,
          after,
          candidates: series.filter((s) => s.direction === "debit").map((s) => s.label),
        });
        return {
          name,
          args,
          result,
          ok: true,
          summary: matched
            ? `Cancelling ${matched.label}: est. saving ${result.estimated_monthly_saving ?? "n/a"}/month`
            : `No recurring payment matched "${query}"`,
        };
      }
      case "list_insights": {
        let insights: unknown = null;
        for (const ref of INSIGHT_CANDIDATES) {
          try {
            insights = await ctx.runQuery(ref, { accountId });
            break;
          } catch {
            // module not deployed (yet) — try next candidate / fall through
          }
        }
        const series: Doc<"recurringSeries">[] = await ctx.runQuery(api.forecast.queries.listRecurringSeries, {
          accountId,
        });
        const anomalies = series
          .filter((s) => s.anomalyKind)
          .map((s) => ({ merchant: s.label, anomaly: s.anomalyKind, detail: s.anomalyDetail ?? null }));
        const compact = Array.isArray(insights)
          ? insights.slice(0, 15).map((i) => {
              const row = (i ?? {}) as Record<string, unknown>;
              return {
                severity: row.severity ?? null,
                kind: row.kind ?? null,
                title: row.title ?? null,
                detail: row.detail ?? null,
              };
            })
          : null;
        const result = {
          insights_available: compact !== null,
          insights: compact ?? [],
          recurring_payment_anomalies: anomalies,
          note:
            compact === null
              ? "The insights feed is not available in this deployment; only anomaly flags on recurring payments are shown."
              : "Alerts are rule-based (thresholds on detected patterns), not AI-generated.",
        };
        return {
          name,
          args,
          result,
          ok: true,
          summary: `${result.insights.length} alert(s), ${anomalies.length} anomaly flag(s)`,
        };
      }
      default:
        return fail(name, args, `Unknown tool "${name}".`);
    }
  } catch (err) {
    return fail(name, args, err instanceof Error ? err.message : String(err));
  }
}

function fail(name: string, args: Record<string, unknown>, message: string): ToolExecution {
  return { name, args, ok: false, result: { error: message }, summary: `failed: ${message}` };
}

async function currencyOf(ctx: ActionCtx, accountId: Id<"accounts">): Promise<string> {
  const f = await ctx.runQuery(api.forecast.queries.getForecast, { accountId, horizonDays: 7 });
  return f?.currency ?? "ZAR";
}

/** Case-insensitive match on label or merchantKey; prefers debits, then the closest label. */
export function matchSeries<T extends { label: string; merchantKey: string; direction: "debit" | "credit" }>(
  series: T[],
  query: string,
): T | null {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = series
    .map((s) => {
      const hay = `${s.label} ${s.merchantKey}`.toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t)).length;
      return { s, score: hits + (s.direction === "debit" ? 0.5 : 0) };
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score || a.s.label.length - b.s.label.length);
  return scored[0]?.s ?? null;
}
