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
});
