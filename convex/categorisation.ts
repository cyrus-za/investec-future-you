/**
 * Spend categorisation — Convex functions.
 *
 *   api.categorisation.recompute({ accountId })         public, used by the UI (idempotent)
 *   internal.categorisation.recomputeForAccount(...)    same logic, for the sync pipeline
 *   api.categorisation.summary({ accountId, months? })  per-month spend by category,
 *                                                       fixed vs variable, top merchants
 *
 * Pure logic lives in convex/categorisation/{rules,categorise}.ts so it can be
 * unit-tested without a backend. Field written: transactions.category.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { categoriseTransaction } from "./categorisation/categorise";
import { CATEGORY_LABELS, isCategory, type Category } from "./categorisation/rules";
import { merchantBaseName } from "./investec/mapping";

const DEFAULT_MONTHS = 3;
const MAX_MONTHS = 12;
const TOP_MERCHANTS = 8;
/** Transactions are stored at SAST midnight (see investec/mapping.ts), so
 * bucket by month in SAST rather than UTC to keep "the 1st" in the right month. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

async function recomputeCategories(ctx: MutationCtx, accountId: Id<"accounts">) {
  let processed = 0;
  let updated = 0;
  const byCategory: Record<string, number> = {};

  // Async iteration streams rows instead of materialising the whole account
  // history; we only write rows whose category actually changed, so re-running
  // after every sync is cheap and idempotent.
  const rows = ctx.db
    .query("transactions")
    .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", accountId));
  for await (const tx of rows) {
    processed++;
    const { category } = categoriseTransaction({
      description: tx.description,
      merchantName: tx.merchantName,
      transactionType: tx.transactionType,
      mcc: tx.mcc,
      amountCents: tx.amountCents,
    });
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    if (tx.category !== category) {
      await ctx.db.patch(tx._id, { category });
      updated++;
    }
  }
  return { processed, updated, byCategory };
}

const recomputeResult = v.object({
  processed: v.number(),
  updated: v.number(),
  byCategory: v.record(v.string(), v.number()),
});

/** Internal entry point for the sync pipeline (call after upserting transactions). */
export const recomputeForAccount = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: recomputeResult,
  handler: async (ctx, args) => recomputeCategories(ctx, args.accountId),
});

/** Public entry point so the dashboard can (re)categorise on demand. Idempotent. */
export const recompute = mutation({
  args: { accountId: v.id("accounts") },
  returns: recomputeResult,
  handler: async (ctx, args) => recomputeCategories(ctx, args.accountId),
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function monthKeyOf(postedAt: number): string {
  const d = new Date(postedAt + SAST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabelOf(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-ZA", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/** The `months` calendar months ending with the month containing `anchorMs`. */
function monthWindow(anchorMs: number, months: number): string[] {
  const d = new Date(anchorMs + SAST_OFFSET_MS);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    keys.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

const categoryTotal = v.object({
  category: v.string(),
  label: v.string(),
  cents: v.number(),
  /** Share of total spend in the window, 0..1. */
  share: v.number(),
});

export const summaryValidator = v.object({
  accountId: v.id("accounts"),
  currency: v.string(),
  /** Window is anchored on the most recent transaction, not the wall clock. */
  anchorMs: v.number(),
  months: v.number(),
  /** Months in the window that contain at least one transaction. */
  monthsWithData: v.number(),
  /**
   * Months the `averageMonthly*` figures are computed over. The month that is
   * still in progress (`partialMonth`) is excluded when at least one complete
   * month with data exists, so a half-finished month doesn't drag averages down.
   */
  averagingMonths: v.array(v.string()),
  partialMonth: v.union(v.string(), v.null()),
  transactionCount: v.number(),
  uncategorisedCount: v.number(),
  perMonth: v.array(
    v.object({
      month: v.string(), // "YYYY-MM"
      label: v.string(), // "Jul 2026"
      partial: v.boolean(),
      spendCents: v.number(),
      incomeCents: v.number(),
      fixedCents: v.number(),
      byCategory: v.record(v.string(), v.number()), // debits only, positive magnitudes
    }),
  ),
  averageMonthlyByCategory: v.array(categoryTotal),
  averageMonthlySpendCents: v.number(),
  averageMonthlyIncomeCents: v.number(),
  averageMonthlyFixedCents: v.number(),
  averageMonthlyVariableCents: v.number(),
  /** Window totals (positive magnitudes). */
  spendCents: v.number(),
  incomeCents: v.number(),
  fixedCents: v.number(),
  variableCents: v.number(),
  /** averageMonthlyFixedCents / averageMonthlySpendCents, 0..1 (0 when there is no spend). */
  fixedShare: v.number(),
  fixedSeriesCount: v.number(),
  topMerchants: v.array(
    v.object({
      merchant: v.string(),
      category: v.string(),
      label: v.string(),
      cents: v.number(),
      count: v.number(),
    }),
  ),
});

export const summary = query({
  args: {
    accountId: v.id("accounts"),
    months: v.optional(v.number()),
    /**
     * Client's current time. Used ONLY to decide which month is still in
     * progress; the window itself is anchored on the latest transaction.
     * Without it, the anchor month is assumed to be the in-progress one.
     */
    nowMs: v.optional(v.number()),
  },
  returns: v.union(summaryValidator, v.null()),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const months = Math.min(MAX_MONTHS, Math.max(1, Math.round(args.months ?? DEFAULT_MONTHS)));

    // Anchor the window on the latest posted transaction so the summary is a
    // pure function of the data (queries must not read the wall clock).
    const latest = await ctx.db
      .query("transactions")
      .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .first();
    if (!latest) return null;
    const anchorMs = latest.postedAt;
    const monthKeys = monthWindow(anchorMs, months);
    const partialMonth = monthKeyOf(args.nowMs ?? anchorMs);
    const windowStartMs = Date.UTC(
      Number(monthKeys[0].slice(0, 4)),
      Number(monthKeys[0].slice(5, 7)) - 1,
      1,
    ) - SAST_OFFSET_MS;

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_account_and_postedAt", (q) =>
        q.eq("accountId", args.accountId).gte("postedAt", windowStartMs),
      )
      .collect();

    // "Fixed" = belongs to a recurring series the forecast actually projects
    // (weekly / biweekly / monthly). Irregular series are treated as variable.
    const seriesRows = await ctx.db
      .query("recurringSeries")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const fixedTxIds = new Set<Id<"transactions">>();
    let fixedSeriesCount = 0;
    for (const s of seriesRows) {
      if (s.direction !== "debit" || s.cadence === "irregular") continue;
      fixedSeriesCount++;
      for (const id of s.transactionIds) fixedTxIds.add(id);
    }

    type MonthBucket = {
      spendCents: number;
      incomeCents: number;
      fixedCents: number;
      byCategory: Record<string, number>;
    };
    const perMonthMap = new Map<string, MonthBucket>();
    for (const key of monthKeys) {
      perMonthMap.set(key, { spendCents: 0, incomeCents: 0, fixedCents: 0, byCategory: {} });
    }

    const merchants = new Map<
      string,
      { merchant: string; cents: number; count: number; categories: Record<string, number> }
    >();
    let spendCents = 0;
    let incomeCents = 0;
    let fixedCents = 0;
    let uncategorisedCount = 0;
    let transactionCount = 0;

    for (const tx of transactions as Doc<"transactions">[]) {
      const key = monthKeyOf(tx.postedAt);
      const bucket = perMonthMap.get(key);
      if (!bucket) continue; // outside the window (e.g. future-dated rows)
      transactionCount++;
      if (!tx.category) uncategorisedCount++;
      const category: Category = isCategory(tx.category) ? tx.category : "other";
      const magnitude = Math.abs(tx.amountCents);

      if (tx.amountCents >= 0) {
        bucket.incomeCents += magnitude;
        incomeCents += magnitude;
        continue;
      }

      bucket.spendCents += magnitude;
      bucket.byCategory[category] = (bucket.byCategory[category] ?? 0) + magnitude;
      spendCents += magnitude;
      if (fixedTxIds.has(tx._id)) {
        fixedCents += magnitude;
        bucket.fixedCents += magnitude;
      }

      const merchantKey = merchantBaseName(tx.merchantName ?? tx.description) || "UNKNOWN";
      const m = merchants.get(merchantKey) ?? {
        merchant: tx.merchantName ?? tx.description,
        cents: 0,
        count: 0,
        categories: {},
      };
      m.cents += magnitude;
      m.count++;
      m.categories[category] = (m.categories[category] ?? 0) + 1;
      merchants.set(merchantKey, m);
    }

    const hasData = (k: string) => {
      const b = perMonthMap.get(k)!;
      return b.spendCents > 0 || b.incomeCents > 0;
    };
    const monthsWithDataKeys = monthKeys.filter(hasData);
    const completeMonthsWithData = monthsWithDataKeys.filter((k) => k !== partialMonth);
    // Prefer complete months; fall back to whatever we have (e.g. brand-new account).
    const averagingMonths =
      completeMonthsWithData.length > 0 ? completeMonthsWithData : monthsWithDataKeys;
    const divisor = Math.max(1, averagingMonths.length);
    const variableCents = spendCents - fixedCents;

    let avgSpend = 0;
    let avgIncome = 0;
    let avgFixed = 0;
    const avgByCategory: Partial<Record<Category, number>> = {};
    for (const k of averagingMonths) {
      const b = perMonthMap.get(k)!;
      avgSpend += b.spendCents;
      avgIncome += b.incomeCents;
      avgFixed += b.fixedCents;
      for (const [c, cents] of Object.entries(b.byCategory)) {
        avgByCategory[c as Category] = (avgByCategory[c as Category] ?? 0) + cents;
      }
    }

    const averageMonthlyByCategory = (Object.entries(avgByCategory) as [Category, number][])
      .map(([category, cents]) => ({
        category,
        label: CATEGORY_LABELS[category],
        cents: Math.round(cents / divisor),
        share: avgSpend > 0 ? cents / avgSpend : 0,
      }))
      .sort((a, b) => b.cents - a.cents);

    const topMerchants = [...merchants.values()]
      .sort((a, b) => b.cents - a.cents)
      .slice(0, TOP_MERCHANTS)
      .map((m) => {
        const category = (Object.entries(m.categories).sort((a, b) => b[1] - a[1])[0]?.[0] ??
          "other") as Category;
        return {
          merchant: m.merchant,
          category,
          label: CATEGORY_LABELS[category],
          cents: m.cents,
          count: m.count,
        };
      });

    return {
      accountId: account._id,
      currency: account.currency,
      anchorMs,
      months,
      monthsWithData: monthsWithDataKeys.length,
      averagingMonths,
      partialMonth: monthKeys.includes(partialMonth) ? partialMonth : null,
      transactionCount,
      uncategorisedCount,
      perMonth: monthKeys.map((month) => {
        const b = perMonthMap.get(month)!;
        return { month, label: monthLabelOf(month), partial: month === partialMonth, ...b };
      }),
      averageMonthlyByCategory,
      averageMonthlySpendCents: Math.round(avgSpend / divisor),
      averageMonthlyIncomeCents: Math.round(avgIncome / divisor),
      averageMonthlyFixedCents: Math.round(avgFixed / divisor),
      averageMonthlyVariableCents: Math.round((avgSpend - avgFixed) / divisor),
      spendCents,
      incomeCents,
      fixedCents,
      variableCents,
      fixedShare: avgSpend > 0 ? avgFixed / avgSpend : 0,
      fixedSeriesCount,
      topMerchants,
    };
  },
});
