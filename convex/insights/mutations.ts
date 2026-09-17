import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "../_generated/server";
import type { AnomalyKind, CadenceLabel } from "../recurring/detect";
import { deriveInsights, type DerivedInsight } from "./derive";

/** Stable identity for "the same insight" across recomputes, so a dismissal
 * survives the next sync until the message materially changes. */
function insightKey(i: { kind: string; relatedMerchantKey?: string; title: string }): string {
  return `${i.kind}|${i.relatedMerchantKey ?? ""}|${i.title}`;
}

export function currencySymbol(currency: string | undefined): string {
  return !currency || currency.toUpperCase() === "ZAR" ? "R" : `${currency.toUpperCase()} `;
}

/**
 * Clear and rewrite the insights for one account from its current
 * recurringSeries rows and balance. Called at the end of
 * `internal.recurring.detect.recompute` (same transaction) and exposed as
 * `internal.insights.mutations.recompute` for manual re-runs.
 */
export async function recomputeInsightsForAccount(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<{ insightCount: number }> {
  const account = await ctx.db.get(accountId);
  if (!account) return { insightCount: 0 };

  const seriesRows: Doc<"recurringSeries">[] = await ctx.db
    .query("recurringSeries")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();

  const existing = await ctx.db
    .query("insights")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  const dismissedAtByKey = new Map<string, number>();
  for (const row of existing) {
    if (row.dismissedAt !== undefined) dismissedAtByKey.set(insightKey(row), row.dismissedAt);
    await ctx.db.delete(row._id);
  }

  const now = Date.now();
  const derived: DerivedInsight[] = deriveInsights({
    series: seriesRows.map((s) => ({
      merchantKey: s.merchantKey,
      label: s.label,
      direction: s.direction,
      cadence: s.cadence as CadenceLabel,
      typicalAmountCents: s.typicalAmountCents,
      lastAmountCents: s.lastAmountCents,
      intervalDays: s.intervalDays,
      predictedNextAt: s.predictedNextAt,
      confidence: s.confidence,
      isPayday: s.isPayday,
      category: s.category,
      anomalyKind: s.anomalyKind as AnomalyKind | undefined,
      anomalyDetail: s.anomalyDetail,
    })),
    // Prefer the authoritative balance-endpoint figure when the sync has it.
    currentBalanceCents: account.availableBalanceCents ?? account.currentBalanceCents ?? 0,
    asOfMs: now,
    currencySymbol: currencySymbol(account.currency),
  });

  for (const d of derived) {
    const dismissedAt = dismissedAtByKey.get(insightKey(d));
    await ctx.db.insert("insights", {
      accountId,
      kind: d.kind,
      severity: d.severity,
      title: d.title,
      detail: d.detail,
      ...(d.relatedMerchantKey ? { relatedMerchantKey: d.relatedMerchantKey } : {}),
      createdAt: now,
      ...(dismissedAt !== undefined ? { dismissedAt } : {}),
    });
  }
  return { insightCount: derived.length };
}

export const recompute = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.object({ insightCount: v.number() }),
  handler: async (ctx, args) => recomputeInsightsForAccount(ctx, args.accountId),
});

/** Hide an insight. It stays hidden across recomputes until its text changes. */
export const dismiss = mutation({
  args: { insightId: v.id("insights") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.insightId);
    if (!row || row.dismissedAt !== undefined) return null;
    await ctx.db.patch(args.insightId, { dismissedAt: Date.now() });
    return null;
  },
});
