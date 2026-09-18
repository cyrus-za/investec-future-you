import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import { createTestBackend } from "../test.setup";
import { deriveInsights, monthlyEquivalentCents, type InsightSeriesInput } from "./derive";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 17); // 17 Sep 2026

function series(partial: Partial<InsightSeriesInput> & { merchantKey: string }): InsightSeriesInput {
  return {
    label: partial.merchantKey,
    direction: "debit",
    cadence: "monthly",
    typicalAmountCents: 10000,
    intervalDays: 30,
    predictedNextAt: NOW + 10 * DAY_MS,
    confidence: 0.9,
    isPayday: false,
    ...partial,
  };
}

describe("deriveInsights (pure)", () => {
  it("returns nothing for a healthy account with no anomalies", () => {
    const out = deriveInsights({
      series: [series({ merchantKey: "NETFLIX", category: "subscription", typicalAmountCents: 19900 })],
      currentBalanceCents: 5_000_000,
      asOfMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it("maps series anomalies to insights with the right severity", () => {
    const out = deriveInsights({
      series: [
        series({
          merchantKey: "CITY POWER",
          category: "utility",
          typicalAmountCents: 180000,
          lastAmountCents: 261000,
          anomalyKind: "amount_spike",
          anomalyDetail: "+45% vs usual",
        }),
        series({
          merchantKey: "DSTV",
          category: "subscription",
          typicalAmountCents: 89900,
          predictedNextAt: NOW - 60 * DAY_MS,
          anomalyKind: "missed_payment",
          anomalyDetail: "Expected 15 Jul, last seen 15 Jun",
        }),
        series({ merchantKey: "GYM", typicalAmountCents: 45000, lastAmountCents: 30000, anomalyKind: "amount_drop", anomalyDetail: "-33% vs usual" }),
      ],
      currentBalanceCents: 5_000_000,
      asOfMs: NOW,
    });
    expect(out.map((i) => [i.kind, i.severity])).toEqual([
      ["amount_spike", "warning"],
      ["missed_payment", "warning"],
      ["amount_drop", "info"],
    ]);
    expect(out[0].title).toBe("CITY POWER charged R2,610 — +45% vs usual");
    expect(out[0].relatedMerchantKey).toBe("CITY POWER");
    expect(out[1].detail).toContain("Expected 15 Jul, last seen 15 Jun");
  });

  it("sums subscriptions into a monthly figure with a share of payday income", () => {
    const out = deriveInsights({
      series: [
        series({ merchantKey: "NETFLIX", category: "subscription", typicalAmountCents: 19900 }),
        series({ merchantKey: "SPOTIFY", category: "subscription", typicalAmountCents: 9900 }),
        series({ merchantKey: "SHOWMAX", category: "subscription", typicalAmountCents: 9900 }),
        series({ merchantKey: "GYM", category: "subscription", typicalAmountCents: 45000, cadence: "irregular" }),
        series({ merchantKey: "SALARY", direction: "credit", isPayday: true, category: "income", typicalAmountCents: 3800000 }),
      ],
      currentBalanceCents: 5_000_000,
      asOfMs: NOW,
    });
    const creep = out.find((i) => i.kind === "subscription_creep")!;
    expect(creep.title).toBe("You spend R397/month on 3 subscriptions"); // irregular gym excluded
    expect(creep.severity).toBe("info");
    expect(creep.detail).toContain("about 1% of your detected monthly income");
  });

  it("flags a cluster of >= 3 debits inside a 3-day window", () => {
    const out = deriveInsights({
      series: [
        series({ merchantKey: "RENT", typicalAmountCents: 1250000, predictedNextAt: NOW + 5 * DAY_MS }),
        series({ merchantKey: "INSURANCE", typicalAmountCents: 85000, predictedNextAt: NOW + 6 * DAY_MS }),
        series({ merchantKey: "GYM", typicalAmountCents: 45000, predictedNextAt: NOW + 7 * DAY_MS }),
        series({ merchantKey: "NETFLIX", typicalAmountCents: 19900, predictedNextAt: NOW + 20 * DAY_MS }),
      ],
      currentBalanceCents: 1_000_000, // R10,000 < cluster total of R13,800
      asOfMs: NOW,
    });
    const clusters = out.filter((i) => i.kind === "upcoming_cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].title).toBe("3 recurring debits (R13,800) expected between 22 Sep and 24 Sep");
    expect(clusters[0].severity).toBe("warning");
  });

  it("raises a cashflow_risk when the 30-day forecast breaches zero", () => {
    const out = deriveInsights({
      series: [series({ merchantKey: "RENT", typicalAmountCents: 1250000, predictedNextAt: NOW + 3 * DAY_MS })],
      currentBalanceCents: 500000,
      asOfMs: NOW,
    });
    const risk = out.find((i) => i.kind === "cashflow_risk")!;
    expect(risk.severity).toBe("critical"); // within 7 days
    expect(risk.title).toBe("Balance projected to dip below R0 around 20 Sep");
    expect(risk.detail).toContain("not a guarantee");
    expect(out[0].kind).toBe("cashflow_risk"); // critical sorts first
  });

  it("does not let a stopped (missed) series drive the cashflow projection", () => {
    const out = deriveInsights({
      series: [
        series({
          merchantKey: "DSTV",
          typicalAmountCents: 1250000,
          predictedNextAt: NOW - 60 * DAY_MS,
          anomalyKind: "missed_payment",
        }),
      ],
      currentBalanceCents: 500000,
      asOfMs: NOW,
    });
    expect(out.find((i) => i.kind === "cashflow_risk")).toBeUndefined();
  });

  it("converts cadences to monthly equivalents", () => {
    expect(monthlyEquivalentCents({ cadence: "weekly", typicalAmountCents: 1200 })).toBe(5200);
    expect(monthlyEquivalentCents({ cadence: "biweekly", typicalAmountCents: 1200 })).toBe(2600);
    expect(monthlyEquivalentCents({ cadence: "irregular", typicalAmountCents: 1200 })).toBe(0);
  });
});

describe("insights (convex-test, seeded demo account)", () => {
  it("seed → detection → insights list contains the electricity spike, subscription creep and stopped DSTV", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});

    const insights = await t.query(api.insights.queries.list, { accountId });
    const kinds = insights.map((i) => i.kind);
    expect(kinds).toContain("amount_spike");
    expect(kinds).toContain("subscription_creep");
    expect(kinds).toContain("missed_payment");

    const spike = insights.find((i) => i.kind === "amount_spike")!;
    expect(spike.relatedMerchantKey).toBe("CITY POWER");
    expect(spike.title).toMatch(/CITY POWER charged R[\d,]+ — \+4\d% vs usual/);

    const creep = insights.find((i) => i.kind === "subscription_creep")!;
    // Netflix R199 + Spotify R99 + Showmax R99 + Virgin Active R450 (gym keyword); DSTV stopped but still a series.
    expect(creep.title).toMatch(/^You spend R[\d,]+\/month on \d subscriptions$/);

    const missed = insights.find((i) => i.kind === "missed_payment")!;
    expect(missed.relatedMerchantKey).toBe("DSTV");

    // Severity ordering: warnings before infos.
    const severities = insights.map((i) => i.severity);
    const firstInfo = severities.indexOf("info");
    const lastWarning = severities.lastIndexOf("warning");
    if (firstInfo !== -1 && lastWarning !== -1) expect(lastWarning).toBeLessThan(firstInfo);
  });

  it("series rows carry category, transactionType, lastAmountCents and anomaly fields", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    type Row = { merchantKey: string; cadence: string; [k: string]: unknown };
    const rows = (await t.query(api.forecast.queries.listRecurringSeries, { accountId })) as Row[];
    const byKey = new Map<string, Row>(rows.map((r) => [r.merchantKey, r]));

    expect(byKey.get("CITY POWER")).toMatchObject({
      category: "utility",
      transactionType: "DebitOrders",
      anomalyKind: "amount_spike",
    });
    expect(byKey.get("WOOLWORTHS")).toMatchObject({ category: "groceries", transactionType: "CardPurchases" });
    expect(byKey.get("ACME CORP")).toMatchObject({ category: "income", isPayday: true, transactionType: "Deposits" });
    expect(byKey.get("DSTV")).toMatchObject({ anomalyKind: "missed_payment", cadence: "monthly" });
    expect(byKey.get("TAKEALOT.COM")?.cadence).toBe("irregular");
  });

  it("dismiss hides an insight and the dismissal survives a recompute", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const before = await t.query(api.insights.queries.list, { accountId });
    const target = before.find((i) => i.kind === "subscription_creep")!;

    await t.mutation(api.insights.mutations.dismiss, { insightId: target._id });
    const after = await t.query(api.insights.queries.list, { accountId });
    expect(after.find((i) => i.kind === "subscription_creep")).toBeUndefined();
    expect(after).toHaveLength(before.length - 1);

    // Re-running detection rewrites the table but keeps the dismissal.
    await t.mutation(internal.recurring.detect.recompute, { accountId });
    const afterRecompute = await t.query(api.insights.queries.list, { accountId });
    expect(afterRecompute.find((i) => i.kind === "subscription_creep")).toBeUndefined();
    expect(afterRecompute).toHaveLength(before.length - 1);
  });
});
