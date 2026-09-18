import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { createTestBackend } from "../test.setup";
import { runForecast, type ForecastSeriesInput } from "./engine";

const DAY_MS = 24 * 60 * 60 * 1000;
const AS_OF = Date.UTC(2026, 8, 1); // 2026-09-01, deterministic

describe("forecast (smoke)", () => {
  it("seeds synthetic data and produces a 30-day forecast with a detected payday", async () => {
    const t = createTestBackend();
    const { accountId, transactionsInserted } = await t.mutation(api.seed.seedDemoAccount, {});
    expect(transactionsInserted).toBeGreaterThan(50);

    const forecast = await t.query(api.forecast.queries.getForecast, {
      accountId,
      horizonDays: 30,
      safetyThresholdCents: 0,
    });
    expect(forecast).not.toBeNull();
    expect(forecast!.dailyBalances).toHaveLength(31);
    expect(forecast!.daysUntilPayday).not.toBeNull();
    expect(forecast!.events.some((e) => e.isPayday)).toBe(true);
  });

  it("returns safe-to-spend, runway and bands from getForecast", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const horizonDays = 30;
    const forecast = await t.query(api.forecast.queries.getForecast, {
      accountId,
      horizonDays,
      safetyThresholdCents: 100_000,
    });
    expect(forecast).not.toBeNull();
    expect(forecast!.safeToSpendCents).toBeGreaterThanOrEqual(0);
    if (forecast!.runwayDays !== null) {
      expect(forecast!.runwayDays).toBeGreaterThanOrEqual(0);
      expect(forecast!.runwayDays).toBeLessThanOrEqual(horizonDays);
    }
    const { expected, optimistic, pessimistic } = forecast!.bands;
    expect(optimistic).toHaveLength(expected.length);
    expect(pessimistic).toHaveLength(expected.length);
    for (const i of [0, 5, 10, 20, 30]) {
      expect(optimistic[i].balanceCents).toBeGreaterThanOrEqual(expected[i].balanceCents);
      expect(expected[i].balanceCents).toBeGreaterThanOrEqual(pessimistic[i].balanceCents);
    }
  });

  it("flags an unaffordable purchase on a low-balance account", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const result = await t.query(api.forecast.queries.checkAffordability, {
      accountId,
      amountCents: 999_999_999,
      label: "Private island",
    });
    expect(result).not.toBeNull();
    expect(result!.canAfford).toBe(false);
    expect(result!.safeToSpendAfterPurchaseCents).toBeLessThanOrEqual(result!.safeToSpendCents);
  });
});

describe("forecast engine (pure)", () => {
  const payday: ForecastSeriesInput = {
    merchantKey: "employer",
    label: "Salary",
    direction: "credit",
    cadence: "monthly",
    typicalAmountCents: 3_000_000,
    intervalDays: 30,
    predictedNextAt: AS_OF + 15 * DAY_MS,
    confidence: 0.95,
    isPayday: true,
    amountVariance: 0,
  };
  const rent: ForecastSeriesInput = {
    merchantKey: "landlord",
    label: "Rent",
    direction: "debit",
    cadence: "monthly",
    typicalAmountCents: 800_000,
    intervalDays: 30,
    predictedNextAt: AS_OF + 5 * DAY_MS,
    confidence: 0.9,
    isPayday: false,
    amountVariance: 0,
  };

  it("computes safe-to-spend as min balance before payday minus threshold, floored at 0", () => {
    const result = runForecast({
      currentBalanceCents: 1_000_000,
      series: [payday, rent],
      horizonDays: 30,
      asOfMs: AS_OF,
      safetyThresholdCents: 50_000,
    });
    // Min before payday: 1_000_000 - 800_000 = 200_000; minus 50_000 threshold.
    expect(result.safeToSpendCents).toBe(150_000);
    expect(result.runwayDays).toBeNull();
    expect(result.daysUntilPayday).toBe(15);
  });

  it("floors safe-to-spend at 0 and reports runway when the threshold is breached", () => {
    const result = runForecast({
      currentBalanceCents: 100_000,
      series: [rent],
      horizonDays: 30,
      asOfMs: AS_OF,
      safetyThresholdCents: 0,
    });
    expect(result.safeToSpendCents).toBe(0);
    expect(result.runwayDays).toBe(5);
    expect(result.firstBreachAtMs).toBe(AS_OF + 5 * DAY_MS);
  });

  it("keeps optimistic >= expected >= pessimistic for every day", () => {
    const variable: ForecastSeriesInput = {
      ...rent,
      merchantKey: "utilities",
      label: "Utilities",
      typicalAmountCents: 100_000,
      confidence: 0.4, // excluded from optimistic band
      amountVariance: 0.5, // scaled up 50% in pessimistic band
      predictedNextAt: AS_OF + 2 * DAY_MS,
    };
    const result = runForecast({
      currentBalanceCents: 2_000_000,
      series: [payday, rent, variable],
      horizonDays: 30,
      asOfMs: AS_OF,
      safetyThresholdCents: 0,
    });
    const { expected, optimistic, pessimistic } = result.bands;
    for (let i = 0; i < expected.length; i++) {
      expect(optimistic[i].balanceCents).toBeGreaterThanOrEqual(expected[i].balanceCents);
      expect(expected[i].balanceCents).toBeGreaterThanOrEqual(pessimistic[i].balanceCents);
    }
    // Optimistic excludes the low-confidence series entirely.
    expect(optimistic[3].balanceCents).toBe(2_000_000);
    // Pessimistic charges utilities at 150%: day-2 balance = 2_000_000 - 150_000.
    expect(pessimistic[2].balanceCents).toBe(1_850_000);
  });

  it("applies variable spend as a daily drain from day 1, except in the optimistic band", () => {
    const result = runForecast({
      currentBalanceCents: 1_000_000,
      series: [],
      horizonDays: 10,
      asOfMs: AS_OF,
      safetyThresholdCents: 0,
      variableSpendDailyCents: 10_000,
    });
    expect(result.dailyBalances[0].balanceCents).toBe(1_000_000);
    expect(result.dailyBalances[5].balanceCents).toBe(950_000);
    expect(result.bands.pessimistic[5].balanceCents).toBe(950_000);
    expect(result.bands.optimistic[5].balanceCents).toBe(1_000_000);
    // Runway: 1_000_000 / 10_000 = 100 days > horizon, so no breach.
    expect(result.runwayDays).toBeNull();
  });

  it("excludes series by merchantKey and merges extraEvents with the legacy hypothetical", () => {
    const result = runForecast({
      currentBalanceCents: 1_000_000,
      series: [payday, rent],
      horizonDays: 30,
      asOfMs: AS_OF,
      excludeMerchantKeys: ["landlord"],
      extraEvents: [{ dateMs: AS_OF + 3 * DAY_MS, amountCents: -100_000, label: "Concert" }],
      hypothetical: { dateMs: AS_OF + 4 * DAY_MS, amountCents: -50_000, label: "Dinner" },
    });
    expect(result.events.some((e) => e.merchantKey === "landlord")).toBe(false);
    expect(result.events.some((e) => e.merchantKey === "employer")).toBe(true);
    expect(result.events.filter((e) => e.merchantKey === "__hypothetical__")).toHaveLength(2);
    // Day 4: 1_000_000 - 100_000 - 50_000.
    expect(result.dailyBalances[4].balanceCents).toBe(850_000);
  });
});

describe("forecast queries (seeded)", () => {
  it("returns a variable-spend estimate and applies it when enabled", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const off = await t.query(api.forecast.queries.getForecast, { accountId, horizonDays: 30 });
    const on = await t.query(api.forecast.queries.getForecast, {
      accountId,
      horizonDays: 30,
      includeVariableSpend: true,
    });
    expect(off!.variableSpendDailyCents).toBe(0);
    expect(on!.includeVariableSpend).toBe(true);
    expect(on!.variableSpendDailyCents).toBeGreaterThanOrEqual(0);
    // With a non-negative daily drain, the expected band can only be lower.
    expect(on!.bands.expected[30].balanceCents).toBeLessThanOrEqual(off!.bands.expected[30].balanceCents);
    expect(on!.safeToSpendCents).toBeLessThanOrEqual(off!.safeToSpendCents);
  });

  it("supports scenario exclusions via excludeMerchantKeys", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const base = await t.query(api.forecast.queries.getForecast, { accountId, horizonDays: 30 });
    const debitKey = base!.events.find((e) => e.direction === "debit")?.merchantKey;
    expect(debitKey).toBeTruthy();
    const excluded = await t.query(api.forecast.queries.getForecast, {
      accountId,
      horizonDays: 30,
      excludeMerchantKeys: [debitKey!],
    });
    expect(excluded!.events.some((e) => e.merchantKey === debitKey)).toBe(false);
    expect(excluded!.minBalanceCents).toBeGreaterThanOrEqual(base!.minBalanceCents);
  });

  it("returns a deterministic verdict sentence from checkAffordability", async () => {
    const t = createTestBackend();
    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const no = await t.query(api.forecast.queries.checkAffordability, {
      accountId,
      amountCents: 999_999_999,
      label: "Private island",
    });
    expect(no!.canAfford).toBe(false);
    expect(no!.verdict).toContain("Risky");
    expect(no!.verdict).toContain("not financial advice");
    const yes = await t.query(api.forecast.queries.checkAffordability, {
      accountId,
      amountCents: 100,
      label: "Coffee",
    });
    expect(yes!.verdict).toContain(yes!.canAfford ? "Looks okay" : "Risky");
    expect(yes!.verdict).toContain("Estimate");
  });
});
