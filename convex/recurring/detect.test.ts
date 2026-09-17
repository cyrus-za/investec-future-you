import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { categoriseSeries } from "./categories";
import {
  classifyCadence,
  detectAmountAnomaly,
  detectRecurringSeries,
  isDebitOrderLike,
  isMissed,
  type DetectableTransaction,
} from "./detect";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15); // 15 Jan 2026

let seq = 0;
function tx(
  partial: Omit<DetectableTransaction, "id"> & { id?: string },
): DetectableTransaction {
  return { id: (partial.id ?? `tx${++seq}`) as Id<"transactions">, ...partial };
}

/** n monthly occurrences on the same day-of-month starting at T0. */
function monthly(
  n: number,
  amountCents: number | ((i: number) => number),
  extra: Partial<Pick<DetectableTransaction, "description" | "merchantName" | "transactionType">> = {},
): DetectableTransaction[] {
  return Array.from({ length: n }, (_, i) =>
    tx({
      postedAt: Date.UTC(2026, i, 15),
      amountCents: typeof amountCents === "function" ? amountCents(i) : amountCents,
      description: extra.description ?? "ACME",
      merchantName: extra.merchantName ?? "ACME",
      transactionType: extra.transactionType,
    }),
  );
}

describe("isDebitOrderLike", () => {
  it("uses the Investec transactionType first, then description text", () => {
    expect(isDebitOrderLike({ transactionType: "DebitOrders", description: "X" })).toBe(true);
    expect(isDebitOrderLike({ description: "VIRGIN ACTIVE DEBIT ORDER" })).toBe(true);
    expect(isDebitOrderLike({ description: "OUTSURANCE D/O 12345" })).toBe(true);
    expect(isDebitOrderLike({ transactionType: "CardPurchases", description: "WOOLWORTHS" })).toBe(false);
  });
});

describe("classifyCadence", () => {
  it("widens the monthly window for debit orders only", () => {
    expect(classifyCadence(30)).toBe("monthly");
    expect(classifyCadence(37)).toBe("irregular");
    expect(classifyCadence(37, true)).toBe("monthly");
    expect(classifyCadence(7, true)).toBe("weekly");
    expect(classifyCadence(60, true)).toBe("irregular");
  });
});

describe("categoriseSeries", () => {
  const cases: Array<[string, string]> = [
    ["NETFLIX.COM", "subscription"],
    ["VIRGIN ACTIVE DEBIT ORDER", "subscription"],
    ["CITY POWER ELECTRICITY", "utility"],
    ["OUTSURANCE PREMIUM", "insurance"],
    ["FNB H LOAN 123", "loan"],
    ["RENT PAYMENT SUNSET APARTMENTS", "rent"],
    ["BODY CORPORATE LEVY", "rent"],
    ["WOOLWORTHS SANDTON ZA", "groceries"],
    ["VODACOM AIRTIME", "telecom"],
    ["MONTHLY SERVICE FEE", "fees"],
    ["TAKEALOT.COM ORDER 1000", "other"],
  ];
  for (const [text, expected] of cases) {
    it(`maps "${text}" → ${expected}`, () => {
      expect(categoriseSeries({ text, direction: "debit" }).category).toBe(expected);
    });
  }

  it("matches whole words only (COFFEE is not a fee, TRAIN is not rain)", () => {
    expect(categoriseSeries({ text: "SEATTLE COFFEE CO", direction: "debit" }).category).toBe("other");
    expect(categoriseSeries({ text: "GAUTRAIN TICKET", direction: "debit" }).category).toBe("other");
  });

  it("uses transactionType and payday as fallbacks", () => {
    expect(
      categoriseSeries({ text: "MONTHLY ACCOUNT", transactionType: "FeesAndInterest", direction: "debit" })
        .category,
    ).toBe("fees");
    expect(categoriseSeries({ text: "SALARY ACME", direction: "credit" }).category).toBe("income");
    expect(categoriseSeries({ text: "ACME CORP", direction: "credit", isPayday: true }).category).toBe("income");
    // A credit matching a bill keyword is a refund/transfer, not a bill.
    expect(categoriseSeries({ text: "RENT REFUND", direction: "credit" }).category).toBe("other");
  });
});

describe("detectAmountAnomaly", () => {
  it("needs at least 3 occurrences", () => {
    expect(detectAmountAnomaly([100_00, 200_00])).toBeNull();
  });
  it("flags a spike ≥25% and ≥R50 vs the median of earlier amounts", () => {
    const a = detectAmountAnomaly([180_000, 175_000, 185_000, 180_000, 261_000]);
    expect(a?.kind).toBe("amount_spike");
    expect(a?.ratio).toBeCloseTo(0.45, 2);
  });
  it("flags a drop", () => {
    expect(detectAmountAnomaly([100_000, 100_000, 100_000, 60_000])?.kind).toBe("amount_drop");
  });
  it("ignores small absolute changes even when the ratio is large", () => {
    expect(detectAmountAnomaly([10_00, 10_00, 10_00, 14_00])).toBeNull(); // R10 → R14
  });
  it("ignores changes under 25%", () => {
    expect(detectAmountAnomaly([100_000, 100_000, 100_000, 120_000])).toBeNull();
  });
});

describe("isMissed", () => {
  const s = { cadence: "monthly" as const, predictedNextAt: T0, intervalDays: 30 };
  it("tolerates one interval plus 3 days of grace", () => {
    expect(isMissed(s, T0 + 33 * DAY_MS)).toBe(false);
    expect(isMissed(s, T0 + 34 * DAY_MS)).toBe(true);
  });
  it("never flags irregular series", () => {
    expect(isMissed({ ...s, cadence: "irregular" }, T0 + 400 * DAY_MS)).toBe(false);
  });
});

describe("detectRecurringSeries", () => {
  it("boosts confidence for debit orders with only 2 occurrences", () => {
    const plain = detectRecurringSeries(monthly(2, -45000, { merchantName: "GYM A", description: "GYM A" }));
    const debitOrder = detectRecurringSeries(
      monthly(2, -45000, { merchantName: "GYM B", description: "GYM B", transactionType: "DebitOrders" }),
    );
    expect(plain[0].cadence).toBe("monthly");
    expect(debitOrder[0].cadence).toBe("monthly");
    expect(debitOrder[0].confidence).toBeGreaterThan(plain[0].confidence);
    expect(debitOrder[0].transactionType).toBe("DebitOrders");
    expect(debitOrder[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("treats a 37-day gap as monthly when it is a debit order, irregular otherwise", () => {
    const at = [T0, T0 + 37 * DAY_MS, T0 + 74 * DAY_MS];
    const make = (transactionType?: string) =>
      at.map((postedAt) =>
        tx({ postedAt, amountCents: -85000, description: "OUTSURANCE", merchantName: "OUTSURANCE", transactionType }),
      );
    expect(detectRecurringSeries(make())[0].cadence).toBe("irregular");
    expect(detectRecurringSeries(make("DebitOrders"))[0].cadence).toBe("monthly");
  });

  it("discounts supermarket card purchases relative to the same pattern elsewhere", () => {
    const groceries = detectRecurringSeries(
      monthly(6, -80000, { merchantName: "CHECKERS", description: "CHECKERS", transactionType: "CardPurchases" }),
    );
    const other = detectRecurringSeries(
      monthly(6, -80000, { merchantName: "ACME", description: "ACME", transactionType: "CardPurchases" }),
    );
    expect(groceries[0].category).toBe("groceries");
    expect(groceries[0].confidence).toBeLessThan(other[0].confidence);
  });

  it("assigns categories, lastAmountCents and an amount_spike anomaly", () => {
    const series = detectRecurringSeries(
      monthly(6, (i) => (i === 5 ? -261000 : -180000), {
        merchantName: "CITY POWER",
        description: "CITY POWER ELECTRICITY",
        transactionType: "DebitOrders",
      }),
    );
    expect(series).toHaveLength(1);
    expect(series[0].category).toBe("utility");
    expect(series[0].lastAmountCents).toBe(261000);
    expect(series[0].anomalyKind).toBe("amount_spike");
    expect(series[0].anomalyDetail).toBe("+45% vs usual");
  });

  it("detects an amount_drop", () => {
    const series = detectRecurringSeries(monthly(4, (i) => (i === 3 ? -50000 : -100000)));
    expect(series[0].anomalyKind).toBe("amount_drop");
    expect(series[0].anomalyDetail).toBe("-50% vs usual");
  });

  it("flags a stopped series as missed_payment relative to the newest transaction", () => {
    const dstv = monthly(3, -89900, { merchantName: "DSTV", description: "DSTV", transactionType: "DebitOrders" });
    // Something else keeps posting long after DSTV stopped (Mar 15 → last seen).
    const recent = [
      tx({ postedAt: Date.UTC(2026, 5, 1), amountCents: -100, description: "COFFEE", merchantName: "COFFEE" }),
      tx({ postedAt: Date.UTC(2026, 6, 1), amountCents: -100, description: "COFFEE", merchantName: "COFFEE" }),
    ];
    const series = detectRecurringSeries([...dstv, ...recent]);
    const dstvSeries = series.find((s) => s.merchantKey === "DSTV")!;
    expect(dstvSeries.anomalyKind).toBe("missed_payment");
    expect(dstvSeries.anomalyDetail).toMatch(/^Expected 15 Apr, last seen 15 Mar$/);
    // The still-active series is not flagged.
    expect(series.find((s) => s.merchantKey === "COFFEE")!.anomalyKind).toBeUndefined();
  });

  it("does not flag missed when the series is merely a few days late", () => {
    const rent = monthly(3, -1250000, { merchantName: "RENT", description: "RENT", transactionType: "DebitOrders" });
    const asOfMs = Date.UTC(2026, 3, 15) + 20 * DAY_MS; // predicted 15 Apr, now 5 May
    expect(detectRecurringSeries(rent, { asOfMs })[0].anomalyKind).toBeUndefined();
  });

  it("classifies wildly irregular intervals as irregular with low confidence and no anomalies", () => {
    const txs = [T0, T0 + 3 * DAY_MS, T0 + 50 * DAY_MS, T0 + 52 * DAY_MS].map((postedAt) =>
      tx({ postedAt, amountCents: -120000, description: "TAKEALOT.COM ORDER 1", merchantName: "TAKEALOT.COM" }),
    );
    const [s] = detectRecurringSeries(txs);
    expect(s.cadence).toBe("irregular");
    expect(s.confidence).toBeLessThanOrEqual(0.3);
    expect(s.anomalyKind).toBeUndefined();
  });

  it("marks the largest monthly credit as payday with category income", () => {
    const salary = monthly(4, 3800000, { merchantName: "ACME CORP", description: "ACME CORP", transactionType: "Deposits" });
    const [s] = detectRecurringSeries(salary);
    expect(s.isPayday).toBe(true);
    expect(s.category).toBe("income");
  });
});
