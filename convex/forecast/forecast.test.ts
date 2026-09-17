import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { createTestBackend } from "../test.setup";

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
  });
});
