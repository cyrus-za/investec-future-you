import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import { createTestBackend } from "../test.setup";

describe("categorisation (convex-test)", () => {
  it("recompute categorises every seeded transaction and is idempotent", async () => {
    const t = createTestBackend();
    const { accountId, transactionsInserted } = await t.mutation(api.seed.seedDemoAccount, {});

    const first = await t.mutation(api.categorisation.recompute, { accountId });
    expect(first.processed).toBe(transactionsInserted);
    expect(first.updated).toBe(transactionsInserted); // nothing was categorised before
    expect(first.byCategory.income).toBeGreaterThan(0);
    expect(first.byCategory.rent_housing).toBeGreaterThan(0);
    expect(first.byCategory.subscriptions).toBeGreaterThan(0);
    expect(first.byCategory.groceries).toBeGreaterThan(0);
    expect(first.byCategory.other ?? 0).toBe(0); // every demo merchant is covered by a rule

    const second = await t.mutation(api.categorisation.recompute, { accountId });
    expect(second.processed).toBe(transactionsInserted);
    expect(second.updated).toBe(0);

    // The internal variant (for the sync pipeline) shares the same logic.
    const third = await t.mutation(internal.categorisation.recomputeForAccount, { accountId });
    expect(third.updated).toBe(0);

    // Categories are persisted on the transaction rows themselves.
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", accountId))
        .collect(),
    );
    expect(stored.every((tx) => typeof tx.category === "string")).toBe(true);
    const rent = stored.find((tx) => tx.merchantName === "SUNSET APARTMENTS");
    expect(rent?.category).toBe("rent_housing");
  });

  it("summary reports spend by category with a majority fixed (recurring) share", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    await t.mutation(api.categorisation.recompute, { accountId });

    const summary = await t.query(api.categorisation.summary, { accountId });
    expect(summary).not.toBeNull();
    const s = summary!;

    expect(s.months).toBe(3);
    expect(s.perMonth).toHaveLength(3);
    expect(s.monthsWithData).toBeGreaterThanOrEqual(2);
    expect(s.uncategorisedCount).toBe(0);
    expect(s.transactionCount).toBeGreaterThan(0);

    // The in-progress month is reported but excluded from the averages.
    const latestMonth = s.perMonth[s.perMonth.length - 1];
    expect(s.partialMonth).toBe(latestMonth.month);
    expect(latestMonth.partial).toBe(true);
    expect(s.averagingMonths).not.toContain(latestMonth.month);
    expect(s.averagingMonths.length).toBeGreaterThanOrEqual(1);
    expect(s.averagingMonths.length).toBeLessThanOrEqual(2);

    // Income (salary R38,000 on the 25th) is tracked separately from spend; the
    // average over complete months is a full salary, not a diluted one.
    expect(s.incomeCents).toBeGreaterThan(0);
    expect(s.averageMonthlyIncomeCents).toBe(3_800_000);
    expect(s.averageMonthlySpendCents).toBeGreaterThan(1_500_000); // rent alone is R12,500

    // Rent dominates, and the seeded subscriptions show up.
    const categories = s.averageMonthlyByCategory.map((c) => c.category);
    expect(categories[0]).toBe("rent_housing");
    expect(categories).toContain("subscriptions");
    expect(categories).toContain("insurance");
    expect(categories).toContain("utilities");
    expect(categories).toContain("groceries");
    expect(categories).not.toContain("income");
    for (const c of s.averageMonthlyByCategory) {
      expect(c.cents).toBeGreaterThan(0);
      expect(c.share).toBeGreaterThan(0);
      expect(c.share).toBeLessThanOrEqual(1);
      expect(c.label.length).toBeGreaterThan(0);
    }
    const shareSum = s.averageMonthlyByCategory.reduce((a, c) => a + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 5);

    // Fixed vs variable: rent + insurance + gym + streaming + electricity (+ weekly
    // groceries) are all detected recurring series, so the fixed share is high.
    expect(s.fixedCents + s.variableCents).toBe(s.spendCents);
    expect(s.fixedShare).toBeGreaterThan(0.5);
    expect(s.fixedSeriesCount).toBeGreaterThan(0);
    expect(s.averageMonthlyFixedCents + s.averageMonthlyVariableCents).toBeCloseTo(
      s.averageMonthlySpendCents,
      -1, // rounding of two halves may differ from the rounded total by ~1 cent
    );

    // Top merchants are debits only, sorted by spend, with a category attached.
    expect(s.topMerchants.length).toBeGreaterThan(0);
    expect(s.topMerchants.length).toBeLessThanOrEqual(8);
    expect(s.topMerchants[0].merchant).toBe("SUNSET APARTMENTS");
    expect(s.topMerchants[0].category).toBe("rent_housing");
    for (let i = 1; i < s.topMerchants.length; i++) {
      expect(s.topMerchants[i - 1].cents).toBeGreaterThanOrEqual(s.topMerchants[i].cents);
    }
    expect(s.topMerchants.some((m) => m.merchant === "ACME CORP")).toBe(false);
  });

  it("treats every month as complete when nowMs is in a later month", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    await t.mutation(api.categorisation.recompute, { accountId });
    const s = await t.query(api.categorisation.summary, {
      accountId,
      months: 3,
      nowMs: Date.now() + 90 * 24 * 60 * 60 * 1000,
    });
    expect(s!.partialMonth).toBeNull();
    expect(s!.perMonth.every((m) => !m.partial)).toBe(true);
    expect(s!.averagingMonths).toHaveLength(s!.monthsWithData);
  });

  it("summary before recompute still works, reporting the uncategorised count", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const s = await t.query(api.categorisation.summary, { accountId, months: 6 });
    expect(s).not.toBeNull();
    expect(s!.months).toBe(6);
    expect(s!.perMonth).toHaveLength(6);
    expect(s!.uncategorisedCount).toBe(s!.transactionCount);
    // Everything lands in "other" until categories are computed.
    expect(s!.averageMonthlyByCategory.map((c) => c.category)).toEqual(["other"]);
  });

  it("summary clamps the month window and returns null without transactions", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const clamped = await t.query(api.categorisation.summary, { accountId, months: 99 });
    expect(clamped!.months).toBe(12);

    const emptyAccountId = await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        investecAccountId: "empty",
        investecAccountNumber: "1",
        name: "Empty",
        currency: "ZAR",
        updatedAt: Date.now(),
      }),
    );
    expect(await t.query(api.categorisation.summary, { accountId: emptyAccountId })).toBeNull();
    expect(await t.mutation(api.categorisation.recompute, { accountId: emptyAccountId })).toEqual({
      processed: 0,
      updated: 0,
      byCategory: {},
    });
  });
});
