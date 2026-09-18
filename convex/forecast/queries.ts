import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { runForecast, type ForecastSeriesInput } from "./engine";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Median daily discretionary debit over the last 8 weeks, excluding any
 * transaction that belongs to a detected recurring series. Days with no
 * discretionary spend count as 0, so the median reflects a *typical* day,
 * not an average inflated by big one-offs. */
async function computeVariableSpendDailyCents(
  ctx: { db: any },
  accountId: Id<"accounts">,
  seriesRows: any[],
  asOfMs: number,
): Promise<number> {
  const windowDays = 56;
  const sinceMs = asOfMs - windowDays * DAY_MS;
  const txns = await ctx.db
    .query("transactions")
    .withIndex("by_account_and_postedAt", (q: any) =>
      q.eq("accountId", accountId).gt("postedAt", sinceMs),
    )
    .collect();
  const recurringIds = new Set(seriesRows.flatMap((s: any) => s.transactionIds ?? []));
  const dailyTotals = new Map<number, number>();
  for (const tx of txns) {
    if (tx.amountCents >= 0) continue;
    if (recurringIds.has(tx._id)) continue;
    const dayIdx = Math.floor((tx.postedAt - sinceMs) / DAY_MS);
    if (dayIdx < 0 || dayIdx >= windowDays) continue;
    dailyTotals.set(dayIdx, (dailyTotals.get(dayIdx) ?? 0) + -tx.amountCents);
  }
  const totals = Array.from({ length: windowDays }, (_, i) => dailyTotals.get(i) ?? 0).sort(
    (a, b) => a - b,
  );
  return Math.round((totals[windowDays / 2 - 1] + totals[windowDays / 2]) / 2);
}

function formatMoney(cents: number, currency: string): string {
  const amount = (Math.abs(cents) / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = cents < 0 ? "-" : "";
  return currency === "ZAR" ? `${sign}R ${amount}` : `${sign}${currency} ${amount}`;
}

const extraEventValidator = v.object({
  dateMs: v.number(),
  amountCents: v.number(), // signed: negative = spend
  label: v.string(),
});

async function loadAccountAndSeries(ctx: { db: any }, accountId?: Id<"accounts">) {
  const account = accountId
    ? await ctx.db.get(accountId)
    : await ctx.db.query("accounts").first();
  if (!account) return null;
  const seriesRows = await ctx.db
    .query("recurringSeries")
    .withIndex("by_account", (q: any) => q.eq("accountId", account._id))
    .collect();
  const series: ForecastSeriesInput[] = seriesRows.map((s: any) => ({
    merchantKey: s.merchantKey,
    label: s.label,
    direction: s.direction,
    cadence: s.cadence,
    typicalAmountCents: s.typicalAmountCents,
    intervalDays: s.intervalDays,
    predictedNextAt: s.predictedNextAt,
    confidence: s.confidence,
    isPayday: s.isPayday,
    amountVariance: s.amountVariance ?? 0,
  }));
  return { account, series, seriesRows };
}

export const getForecast = query({
  args: {
    accountId: v.optional(v.id("accounts")),
    horizonDays: v.optional(v.number()),
    safetyThresholdCents: v.optional(v.number()),
    includeVariableSpend: v.optional(v.boolean()),
    excludeMerchantKeys: v.optional(v.array(v.string())),
    extraEvents: v.optional(v.array(extraEventValidator)),
  },
  handler: async (ctx, args) => {
    const loaded = await loadAccountAndSeries(ctx, args.accountId);
    if (!loaded) return null;
    const { account, series, seriesRows } = loaded;
    const asOfMs = Date.now();
    const includeVariableSpend = args.includeVariableSpend ?? false;
    const variableSpendDailyCents = includeVariableSpend
      ? await computeVariableSpendDailyCents(ctx, account._id, seriesRows, asOfMs)
      : 0;
    const result = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays: args.horizonDays,
      safetyThresholdCents: args.safetyThresholdCents,
      asOfMs,
      variableSpendDailyCents,
      excludeMerchantKeys: args.excludeMerchantKeys,
      extraEvents: args.extraEvents,
    });
    return {
      accountId: account._id,
      accountName: account.name,
      currency: account.currency,
      balanceAsOf: account.balanceAsOf ?? null,
      includeVariableSpend,
      variableSpendDailyCents,
      ...result,
    };
  },
});

export const listRecurringSeries = query({
  args: { accountId: v.optional(v.id("accounts")) },
  handler: async (ctx, args) => {
    const loaded = await loadAccountAndSeries(ctx, args.accountId);
    if (!loaded) return [];
    return loaded.seriesRows
      .slice()
      .sort((a: any, b: any) => a.predictedNextAt - b.predictedNextAt);
  },
});

export const checkAffordability = query({
  args: {
    accountId: v.optional(v.id("accounts")),
    amountCents: v.number(), // positive = cost of the purchase
    dateMs: v.optional(v.number()),
    label: v.optional(v.string()),
    horizonDays: v.optional(v.number()),
    safetyThresholdCents: v.optional(v.number()),
    includeVariableSpend: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const loaded = await loadAccountAndSeries(ctx, args.accountId);
    if (!loaded) return null;
    const { account, series, seriesRows } = loaded;
    const asOfMs = Date.now();
    const dateMs = args.dateMs ?? asOfMs;
    const horizonDays = Math.max(
      args.horizonDays ?? 30,
      Math.ceil((dateMs - asOfMs) / DAY_MS) + 1,
    );
    const safetyThresholdCents = args.safetyThresholdCents ?? 0;
    const includeVariableSpend = args.includeVariableSpend ?? false;
    const variableSpendDailyCents = includeVariableSpend
      ? await computeVariableSpendDailyCents(ctx, account._id, seriesRows, asOfMs)
      : 0;
    const label = args.label ?? "Hypothetical purchase";

    const baseline = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays,
      safetyThresholdCents,
      asOfMs,
      variableSpendDailyCents,
    });
    const withPurchase = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays,
      safetyThresholdCents,
      asOfMs,
      variableSpendDailyCents,
      hypothetical: {
        dateMs,
        amountCents: -Math.abs(args.amountCents),
        label,
      },
    });

    const wouldBreach =
      withPurchase.firstBreachAtMs !== null &&
      (baseline.firstBreachAtMs === null || withPurchase.firstBreachAtMs < baseline.firstBreachAtMs);
    const canAfford = !wouldBreach && withPurchase.minBalanceCents >= safetyThresholdCents;

    const purchaseDate = new Date(dateMs).toISOString().slice(0, 10);
    const minDate = new Date(withPurchase.minBalanceAtMs).toISOString().slice(0, 10);
    const verdict = canAfford
      ? `Looks okay: after ${formatMoney(args.amountCents, account.currency)} on ${purchaseDate}, your projected balance stays above your ${formatMoney(safetyThresholdCents, account.currency)} safety buffer for the next ${horizonDays} days (low point ${formatMoney(withPurchase.minBalanceCents, account.currency)} on ${minDate}). Estimate based on detected recurring payments${includeVariableSpend ? " and your typical day-to-day spend" : ""} — not a guarantee or financial advice.`
      : `Risky: ${formatMoney(args.amountCents, account.currency)} on ${purchaseDate} would push your projected balance to ${formatMoney(withPurchase.minBalanceCents, account.currency)} around ${minDate}, below your ${formatMoney(safetyThresholdCents, account.currency)} safety buffer${baseline.daysUntilPayday !== null ? ` — payday is ~${baseline.daysUntilPayday} day${baseline.daysUntilPayday === 1 ? "" : "s"} away, so waiting might help` : ""}. Estimate only — not financial advice.`;

    return {
      currency: account.currency,
      canAfford,
      verdict,
      baselineMinBalanceCents: baseline.minBalanceCents,
      projectedMinBalanceCents: withPurchase.minBalanceCents,
      projectedMinBalanceAtMs: withPurchase.minBalanceAtMs,
      firstBreachAtMs: withPurchase.firstBreachAtMs,
      daysUntilPayday: baseline.daysUntilPayday,
      dailyBalances: withPurchase.dailyBalances,
      safeToSpendCents: baseline.safeToSpendCents,
      safeToSpendAfterPurchaseCents: withPurchase.safeToSpendCents,
      runwayDays: withPurchase.runwayDays,
      bands: withPurchase.bands,
      includeVariableSpend,
      variableSpendDailyCents,
    };
  },
});
