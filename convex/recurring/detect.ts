import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { recomputeInsightsForAccount } from "../insights/mutations";
import { merchantBaseName } from "../investec/mapping";
import { categoriseSeries, type SeriesCategory } from "./categories";
import { formatPct, shortDate } from "./format";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CadenceLabel = "weekly" | "biweekly" | "monthly" | "irregular";
export type AnomalyKind = "amount_spike" | "amount_drop" | "missed_payment";

export type DetectableTransaction = {
  id: Id<"transactions">;
  postedAt: number;
  amountCents: number; // signed
  merchantName?: string | null;
  description: string;
  /** Investec transactionType, e.g. "DebitOrders", "CardPurchases", "Deposits". */
  transactionType?: string | null;
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
  category: SeriesCategory;
  transactionType?: string;
  lastAmountCents: number;
  anomalyKind?: AnomalyKind;
  anomalyDetail?: string;
  transactionIds: Id<"transactions">[];
};

/** All tunable thresholds in one place (documented in docs/detection-insights.md). */
export const DETECTION = {
  /** Relative change vs the series' usual amount to count as a spike/drop. */
  amountChangeRatio: 0.25,
  /** Absolute floor for spike/drop so R10 → R14 doesn't alert. */
  amountChangeMinCents: 5000, // R50
  /** Change must also exceed this many standard deviations of the earlier
   * amounts, so a naturally variable series (weekly groceries) doesn't alert. */
  amountChangeMinSigmas: 2,
  /** Need at least this many occurrences before judging the "usual" amount. */
  minOccurrencesForAmountAnomaly: 3,
  /** Missed = overdue by more than one interval + this many grace days. */
  missedGraceDays: 3,
  /** Debit orders: widened interval window (days) still treated as monthly. */
  debitOrderMonthlyWindow: [20, 40] as const,
  /** Debit orders: counted as if they had this many extra occurrences. */
  debitOrderOccurrenceBonus: 2,
  /** Debit orders: flat confidence bonus once a cadence is established. */
  debitOrderConfidenceBonus: 0.05,
  /** Card purchases at supermarkets are discretionary → shave confidence. */
  cardPurchaseGroceriesFactor: 0.9,
  maxConfidence: 0.98,
} as const;

const DEBIT_ORDER_TEXT = /\bDEBIT\s*ORDER\b|\bD\/O\b|\bDEBIT\s*ORD\b/i;

/** True when Investec labels the row a debit order, or the description says so. */
export function isDebitOrderLike(tx: {
  transactionType?: string | null;
  description: string;
  merchantName?: string | null;
}): boolean {
  if (tx.transactionType === "DebitOrders") return true;
  return DEBIT_ORDER_TEXT.test(tx.description) || DEBIT_ORDER_TEXT.test(tx.merchantName ?? "");
}

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

function mode(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function classifyCadence(intervalDays: number, isDebitOrder = false): CadenceLabel {
  if (intervalDays >= 5 && intervalDays <= 9) return "weekly";
  if (intervalDays >= 10 && intervalDays <= 18) return "biweekly";
  if (intervalDays >= 24 && intervalDays <= 34) return "monthly";
  // Debit orders are almost always monthly; tolerate a late/early run.
  const [lo, hi] = DETECTION.debitOrderMonthlyWindow;
  if (isDebitOrder && intervalDays >= lo && intervalDays <= hi) return "monthly";
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

export type AmountAnomaly = {
  kind: "amount_spike" | "amount_drop";
  ratio: number; // signed change relative to baseline, e.g. 0.45 = +45%
  baselineCents: number;
};

/**
 * Compare the most recent amount with the median of the *previous*
 * occurrences (so the latest value can't drag its own baseline). Requires
 * >= 3 occurrences; the change must be >= 25%, >= R50 and >= 2 standard
 * deviations of the earlier amounts (all three, so fixed bills are judged
 * strictly and naturally variable series are judged leniently).
 */
export function detectAmountAnomaly(amountsChronological: number[]): AmountAnomaly | null {
  if (amountsChronological.length < DETECTION.minOccurrencesForAmountAnomaly) return null;
  const last = amountsChronological[amountsChronological.length - 1];
  const earlier = amountsChronological.slice(0, -1);
  const baseline = median(earlier);
  if (baseline <= 0) return null;
  const earlierMean = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  const sigma = stddev(earlier, earlierMean);
  const diff = last - baseline;
  const threshold = Math.max(
    DETECTION.amountChangeRatio * baseline,
    DETECTION.amountChangeMinCents,
    DETECTION.amountChangeMinSigmas * sigma,
  );
  if (diff >= threshold) return { kind: "amount_spike", ratio: diff / baseline, baselineCents: baseline };
  if (-diff >= threshold) return { kind: "amount_drop", ratio: diff / baseline, baselineCents: baseline };
  return null;
}

/** A regular series is "missed" once it is overdue by more than one full
 * interval plus a grace period, judged against the newest transaction date
 * in the account (not the wall clock, so a stale sync doesn't cause alarms). */
export function isMissed(
  series: { cadence: CadenceLabel; predictedNextAt: number; intervalDays: number },
  newestTransactionAt: number,
): boolean {
  if (series.cadence === "irregular") return false;
  const overdueMs = newestTransactionAt - series.predictedNextAt;
  return overdueMs > (series.intervalDays + DETECTION.missedGraceDays) * DAY_MS;
}

export type DetectOptions = {
  /** Reference "now" for missed-payment checks. Defaults to the newest transaction date. */
  asOfMs?: number;
};

/**
 * Detect recurring merchant series from a flat list of transactions for one
 * account. Groups by normalised merchant name + direction (debit/credit) —
 * NOT by exact amount, since bills like electricity vary month to month;
 * amount consistency instead feeds the confidence score. Series with fewer
 * than 2 occurrences, or with a wildly irregular interval, are classified
 * "irregular" and excluded from balance forecasting (see forecast/engine.ts).
 *
 * Signals beyond timing: Investec `transactionType` ("DebitOrders" is a
 * strong prior for a monthly bill; "CardPurchases" at a supermarket is weak),
 * keyword categories, and per-series anomalies (spike / drop / missed).
 */
export function detectRecurringSeries(
  transactions: DetectableTransaction[],
  options: DetectOptions = {},
): DetectedSeries[] {
  const groups = new Map<string, DetectableTransaction[]>();
  let newestAt = -Infinity;
  for (const tx of transactions) {
    if (tx.postedAt > newestAt) newestAt = tx.postedAt;
    const direction = tx.amountCents < 0 ? "debit" : "credit";
    const key = `${direction}:${merchantBaseName(tx.merchantName ?? tx.description)}`;
    if (!key.slice(key.indexOf(":") + 1)) continue; // skip empty merchant keys
    const bucket = groups.get(key) ?? [];
    bucket.push(tx);
    groups.set(key, bucket);
  }
  const asOfMs = options.asOfMs ?? newestAt;

  const series: DetectedSeries[] = [];
  for (const [key, txs] of groups.entries()) {
    if (txs.length < 2) continue;
    const [direction, merchantKey] = [key.startsWith("debit") ? "debit" : "credit", key.slice(key.indexOf(":") + 1)] as const;
    const sorted = [...txs].sort((a, b) => a.postedAt - b.postedAt);
    const latest = sorted[sorted.length - 1];

    const transactionType = mode(
      sorted.map((t) => t.transactionType ?? "").filter((t) => t.length > 0),
    );
    const debitOrderVotes = sorted.filter(isDebitOrderLike).length;
    const isDebitOrder = direction === "debit" && debitOrderVotes * 2 >= sorted.length;

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push((sorted[i].postedAt - sorted[i - 1].postedAt) / DAY_MS);
    }
    const intervalDays = Math.round(median(intervals));
    const intervalStdDev = stddev(intervals, intervalDays);
    const cadence = classifyCadence(intervalDays, isDebitOrder);

    const amounts = sorted.map((t) => Math.abs(t.amountCents));
    const typicalAmountCents = Math.round(median(amounts));
    const amountMean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amountVariance =
      amountMean === 0 ? 0 : stddev(amounts, amountMean) / amountMean;

    const occurrenceCount = sorted.length;
    const lastOccurrenceAt = latest.postedAt;
    const label = latest.merchantName || latest.description;

    const { category } = categoriseSeries({
      text: `${latest.merchantName ?? ""} ${latest.description}`,
      transactionType,
      direction,
    });

    // Confidence: more occurrences, tighter interval spread, and tighter
    // amount spread all increase confidence. Each factor is 0..1; combined
    // by simple average and capped. Debit orders count as if they had two
    // extra occurrences (a bank-mandated monthly pull is strong evidence
    // even after two runs); supermarket card purchases are discounted.
    const occurrenceBonus = isDebitOrder ? DETECTION.debitOrderOccurrenceBonus : 0;
    const occurrenceFactor = Math.min((occurrenceCount + occurrenceBonus) / 6, 1);
    const intervalFactor =
      intervalDays === 0 ? 0 : Math.max(0, 1 - intervalStdDev / intervalDays);
    const amountFactor = Math.max(0, 1 - amountVariance);
    let confidence: number;
    if (cadence === "irregular") {
      confidence = Math.min(0.3, occurrenceFactor * 0.3);
    } else {
      confidence = (occurrenceFactor + intervalFactor + amountFactor) / 3;
      if (isDebitOrder) confidence += DETECTION.debitOrderConfidenceBonus;
      if (transactionType === "CardPurchases" && category === "groceries") {
        confidence *= DETECTION.cardPurchaseGroceriesFactor;
      }
      confidence = Math.min(DETECTION.maxConfidence, confidence);
    }
    confidence = Math.round(confidence * 100) / 100;

    const predictedNextAt = predictNext(cadence, lastOccurrenceAt, intervalDays);

    // Anomalies: a stopped series matters more than an old amount change.
    let anomalyKind: AnomalyKind | undefined;
    let anomalyDetail: string | undefined;
    if (isMissed({ cadence, predictedNextAt, intervalDays }, asOfMs)) {
      anomalyKind = "missed_payment";
      anomalyDetail = `Expected ${shortDate(predictedNextAt)}, last seen ${shortDate(lastOccurrenceAt)}`;
    } else {
      const amountAnomaly = detectAmountAnomaly(amounts);
      if (amountAnomaly) {
        anomalyKind = amountAnomaly.kind;
        anomalyDetail = `${formatPct(amountAnomaly.ratio)} vs usual`;
      }
    }

    series.push({
      merchantKey,
      label,
      direction,
      cadence,
      typicalAmountCents,
      amountVariance: Math.round(amountVariance * 100) / 100,
      intervalDays,
      occurrenceCount,
      lastOccurrenceAt,
      predictedNextAt,
      confidence,
      isPayday: false, // set below
      category,
      ...(transactionType ? { transactionType } : {}),
      lastAmountCents: amounts[amounts.length - 1],
      ...(anomalyKind ? { anomalyKind, anomalyDetail } : {}),
      transactionIds: sorted.map((t) => t.id),
    });
  }

  // Payday = the largest-amount monthly credit series.
  let payday: DetectedSeries | null = null;
  for (const s of series) {
    if (s.direction !== "credit" || s.cadence !== "monthly") continue;
    if (!payday || s.typicalAmountCents > payday.typicalAmountCents) payday = s;
  }
  if (payday) {
    payday.isPayday = true;
    if (payday.category === "other") payday.category = "income";
  }

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
        transactionType: t.transactionType,
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

    // Insights are derived from the freshly written series, in the same transaction.
    const { insightCount } = await recomputeInsightsForAccount(ctx, args.accountId);
    return { seriesCount: detected.length, insightCount };
  },
});
