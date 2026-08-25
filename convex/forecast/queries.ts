import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { runForecast, type ForecastSeriesInput } from "./engine";

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
  }));
  return { account, series, seriesRows };
}

export const getForecast = query({
  args: {
    accountId: v.optional(v.id("accounts")),
    horizonDays: v.optional(v.number()),
    safetyThresholdCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const loaded = await loadAccountAndSeries(ctx, args.accountId);
    if (!loaded) return null;
    const { account, series } = loaded;
    const result = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays: args.horizonDays,
      safetyThresholdCents: args.safetyThresholdCents,
    });
    return {
      accountId: account._id,
      accountName: account.name,
      currency: account.currency,
      balanceAsOf: account.balanceAsOf ?? null,
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
  },
  handler: async (ctx, args) => {
    const loaded = await loadAccountAndSeries(ctx, args.accountId);
    if (!loaded) return null;
    const { account, series } = loaded;
    const dateMs = args.dateMs ?? Date.now();
    const horizonDays = Math.max(
      args.horizonDays ?? 30,
      Math.ceil((dateMs - Date.now()) / (24 * 60 * 60 * 1000)) + 1,
    );

    const baseline = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays,
      safetyThresholdCents: args.safetyThresholdCents,
    });
    const withPurchase = runForecast({
      currentBalanceCents: account.currentBalanceCents ?? 0,
      series,
      horizonDays,
      safetyThresholdCents: args.safetyThresholdCents,
      hypothetical: {
        dateMs,
        amountCents: -Math.abs(args.amountCents),
        label: args.label ?? "Hypothetical purchase",
      },
    });

    const wouldBreach =
      withPurchase.firstBreachAtMs !== null &&
      (baseline.firstBreachAtMs === null || withPurchase.firstBreachAtMs < baseline.firstBreachAtMs);

    return {
      currency: account.currency,
      canAfford: !wouldBreach && withPurchase.minBalanceCents >= (args.safetyThresholdCents ?? 0),
      baselineMinBalanceCents: baseline.minBalanceCents,
      projectedMinBalanceCents: withPurchase.minBalanceCents,
      projectedMinBalanceAtMs: withPurchase.minBalanceAtMs,
      firstBreachAtMs: withPurchase.firstBreachAtMs,
      daysUntilPayday: baseline.daysUntilPayday,
      dailyBalances: withPurchase.dailyBalances,
    };
  },
});
