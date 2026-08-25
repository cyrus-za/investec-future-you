import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { merchantBaseName } from "../investec/mapping";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CadenceLabel = "weekly" | "biweekly" | "monthly" | "irregular";

export type DetectableTransaction = {
  id: Id<"transactions">;
  postedAt: number;
  amountCents: number; // signed
  merchantName?: string | null;
  description: string;
};

export type DetectedSeries = {
  merchantKey: string;
  label: string;
  direction: "debit" | "credit";
  cadence: CadenceLabel;
  typicalAmountCents: number; // positive magnitude
  amountVariance: number;
  intervalDays: number;
  occurrenceCount: number;
  lastOccurrenceAt: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
  transactionIds: Id<"transactions">[];
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function classifyCadence(intervalDays: number): CadenceLabel {
  if (intervalDays >= 5 && intervalDays <= 9) return "weekly";
  if (intervalDays >= 10 && intervalDays <= 18) return "biweekly";
  if (intervalDays >= 24 && intervalDays <= 34) return "monthly";
  return "irregular";
}

/** Predict the next occurrence, aligning to day-of-month for monthly cadence
 * so a "28th of the month" bill lands on the 28th even across different
 * month lengths, rather than drifting by a fixed number of days. */
function predictNext(cadence: CadenceLabel, lastOccurrenceAt: number, intervalDays: number): number {
  if (cadence === "monthly") {
    const d = new Date(lastOccurrenceAt);
    const next = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
    );
    return next.getTime();
  }
  return lastOccurrenceAt + intervalDays * DAY_MS;
}

/**
 * Detect recurring merchant series from a flat list of transactions for one
 * account. Groups by normalised merchant name + direction (debit/credit) —
 * NOT by exact amount, since bills like electricity vary month to month;
 * amount consistency instead feeds the confidence score. Series with fewer
 * than 2 occurrences, or with a wildly irregular interval, are classified
 * "irregular" and excluded from balance forecasting (see forecast/engine.ts).
 */
export function detectRecurringSeries(transactions: DetectableTransaction[]): DetectedSeries[] {
  const groups = new Map<string, DetectableTransaction[]>();
  for (const tx of transactions) {
    const direction = tx.amountCents < 0 ? "debit" : "credit";
    const key = `${direction}:${merchantBaseName(tx.merchantName ?? tx.description)}`;
    if (!key.slice(key.indexOf(":") + 1)) continue; // skip empty merchant keys
    const bucket = groups.get(key) ?? [];
    bucket.push(tx);
    groups.set(key, bucket);
  }

  const series: DetectedSeries[] = [];
  for (const [key, txs] of groups.entries()) {
    if (txs.length < 2) continue;
    const [direction, merchantKey] = [key.startsWith("debit") ? "debit" : "credit", key.slice(key.indexOf(":") + 1)] as const;
    const sorted = [...txs].sort((a, b) => a.postedAt - b.postedAt);

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push((sorted[i].postedAt - sorted[i - 1].postedAt) / DAY_MS);
    }
    const intervalDays = Math.round(median(intervals));
    const intervalStdDev = stddev(intervals, intervalDays);
    const cadence = classifyCadence(intervalDays);

    const amounts = sorted.map((t) => Math.abs(t.amountCents));
    const typicalAmountCents = Math.round(median(amounts));
    const amountMean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amountVariance =
      amountMean === 0 ? 0 : stddev(amounts, amountMean) / amountMean;

    const occurrenceCount = sorted.length;
    const lastOccurrenceAt = sorted[sorted.length - 1].postedAt;

    // Confidence: more occurrences, tighter interval spread, and tighter
    // amount spread all increase confidence. Each factor is 0..1; combined
    // by simple average and capped.
    const occurrenceFactor = Math.min(occurrenceCount / 6, 1);
    const intervalFactor =
      intervalDays === 0 ? 0 : Math.max(0, 1 - intervalStdDev / intervalDays);
    const amountFactor = Math.max(0, 1 - amountVariance);
    const confidence =
      cadence === "irregular"
        ? Math.min(0.3, occurrenceFactor * 0.3)
        : Math.round(
            ((occurrenceFactor + intervalFactor + amountFactor) / 3) * 100,
          ) / 100;

    series.push({
      merchantKey,
      label: sorted[sorted.length - 1].merchantName || sorted[sorted.length - 1].description,
      direction,
      cadence,
      typicalAmountCents,
      amountVariance: Math.round(amountVariance * 100) / 100,
      intervalDays,
      occurrenceCount,
      lastOccurrenceAt,
      predictedNextAt: predictNext(cadence, lastOccurrenceAt, intervalDays),
      confidence,
      isPayday: false, // set below
      transactionIds: sorted.map((t) => t.id),
    });
  }

  // Payday = the largest-amount monthly credit series.
  let payday: DetectedSeries | null = null;
  for (const s of series) {
    if (s.direction !== "credit" || s.cadence !== "monthly") continue;
    if (!payday || s.typicalAmountCents > payday.typicalAmountCents) payday = s;
  }
  if (payday) payday.isPayday = true;

  return series;
}

export const recompute = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", args.accountId))
      .collect();

    const detected = detectRecurringSeries(
      transactions.map((t) => ({
        id: t._id,
        postedAt: t.postedAt,
        amountCents: t.amountCents,
        merchantName: t.merchantName,
        description: t.description,
      })),
    );

    const existing = await ctx.db
      .query("recurringSeries")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);

    for (const s of detected) {
      await ctx.db.insert("recurringSeries", {
        accountId: args.accountId,
        ...s,
        updatedAt: Date.now(),
      });
    }
    return { seriesCount: detected.length };
  },
});
