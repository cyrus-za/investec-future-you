import { describe, expect, it } from "vitest";
import { categoriseTransaction, normaliseText } from "./categorise";
import { CATEGORIES, CATEGORY_LABELS, KEYWORD_RULES, MCC_RULES } from "./rules";

const debit = (description: string, extra: Partial<Parameters<typeof categoriseTransaction>[0]> = {}) =>
  categoriseTransaction({ description, amountCents: -12345, ...extra });
const credit = (description: string, extra: Partial<Parameters<typeof categoriseTransaction>[0]> = {}) =>
  categoriseTransaction({ description, amountCents: 12345, ...extra });

describe("normaliseText", () => {
  it("uppercases, strips punctuation and collapses whitespace", () => {
    expect(normaliseText("  Netflix.com  *SUB/2026 ")).toBe("NETFLIX COM SUB 2026");
    expect(normaliseText("MUGG & BEAN")).toBe("MUGG BEAN");
  });
});

describe("categoriseTransaction — South African merchants", () => {
  const cases: [string, string][] = [
    ["WOOLWORTHS SANDTON ZA", "groceries"],
    ["CHECKERS SIXTY60", "groceries"],
    ["PNP CRP WATERFALL", "groceries"],
    ["KWIKSPAR MELVILLE", "groceries"],
    ["SHOPRITE SOWETO", "groceries"],
    ["FOOD LOVERS MARKET", "groceries"],
    ["TAKEALOT.COM ORDER 1000003", "shopping"],
    ["MR PRICE HOME", "shopping"],
    ["UBER *TRIP HELP.UBER.COM", "transport_fuel"],
    ["BOLT.EU/O/2026", "transport_fuel"],
    ["ENGEN WOODMEAD", "transport_fuel"],
    ["SHELL ULTRA CITY N1", "transport_fuel"],
    ["SASOL RIVONIA", "transport_fuel"],
    ["BP MIDRAND", "transport_fuel"],
    ["AVIS RENT A CAR ORT", "transport_fuel"],
    ["VODACOM PREPAID", "telecom"],
    ["MTN SP DEBIT ORDER", "telecom"],
    ["AFRIHOST FIBRE", "telecom"],
    ["DIS-CHEM PHARMACIES", "health"],
    ["CLICKS 1234 ROSEBANK", "health"],
    ["MEDICROSS CLINIC", "health"],
    ["NANDO'S CRESTA", "eating_out"],
    ["STEERS N1 CITY", "eating_out"],
    ["KFC RANDBURG", "eating_out"],
    ["MR D FOOD", "eating_out"],
    ["UBER EATS", "eating_out"],
    ["BOLT FOOD", "eating_out"],
    ["VIDA E CAFFE", "eating_out"],
    ["NETFLIX.COM", "subscriptions"],
    ["SHOWMAX", "subscriptions"],
    ["DSTV PREMIUM MULTICHOICE", "subscriptions"],
    ["SPOTIFY PREMIUM", "subscriptions"],
    ["YOUTUBE PREMIUM", "subscriptions"],
    ["APPLE.COM/BILL", "subscriptions"],
    ["VIRGIN ACTIVE DEBIT ORDER", "subscriptions"],
    ["CITY POWER ELECTRICITY", "utilities"],
    ["ESKOM PREPAID", "utilities"],
    ["CITY OF CAPE TOWN RATES", "utilities"],
    ["OUTSURANCE PREMIUM", "insurance"],
    ["DISCOVERY HEALTH MEDICAL AID", "insurance"],
    ["MOMENTUM LIFE", "insurance"],
    ["SANTAM INSURANCE", "insurance"],
    ["RENT PAYMENT SUNSET APARTMENTS", "rent_housing"],
    ["BODY CORPORATE LEVY", "rent_housing"],
    ["SA HOME LOANS", "rent_housing"],
    ["WESBANK VEHICLE FINANCE", "loans"],
    ["PERSONAL LOAN REPAYMENT", "loans"],
    ["STER-KINEKOR", "entertainment"],
    ["HOLLYWOODBETS", "entertainment"],
    ["MONTHLY SERVICE FEE", "fees_interest"],
    ["DEBIT INTEREST", "fees_interest"],
    ["ATM WITHDRAWAL SANDTON CITY", "cash"],
    ["FNB CASHSEND", "cash"],
    ["TRANSFER TO SAVINGS POCKET", "transfers"],
    ["FASTER PAYMENT J SMITH", "transfers"],
    ["PAYSHAP PAYMENT", "transfers"],
  ];

  it.each(cases)("%s -> %s", (description, expected) => {
    const result = debit(description);
    expect(result.category).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.reason).toMatch(/Matched "/);
  });

  it("uses the merchantName as well as the description", () => {
    expect(debit("CARD PURCHASE 4021", { merchantName: "WOOLWORTHS" }).category).toBe("groceries");
  });

  it("matches whole words only (SPAR does not match SPARKLE)", () => {
    expect(debit("SPARKLE CLEANING").category).not.toBe("groceries");
    expect(debit("SPAR TOKAI").category).toBe("groceries");
  });

  it("supports prefix wildcards for stems (GROCER* / PHARM*)", () => {
    expect(debit("KURUMAN GROCERIES").category).toBe("groceries");
    expect(debit("LINK PHARMACIES").category).toBe("health");
  });
});

describe("categoriseTransaction — precedence", () => {
  it("specific rules beat generic ones (UBER EATS is eating out, UBER is transport)", () => {
    expect(debit("UBER EATS JHB").category).toBe("eating_out");
    expect(debit("UBER TRIP JHB").category).toBe("transport_fuel");
  });

  it("subscriptions beat insurance's generic PREMIUM keyword", () => {
    expect(debit("YOUTUBE PREMIUM").category).toBe("subscriptions");
    expect(debit("OUTSURANCE PREMIUM").category).toBe("insurance");
  });

  it("descriptive EFTs are categorised by content before falling back to transfers", () => {
    expect(debit("PAYMENT TO SUNSET APARTMENTS RENT").category).toBe("rent_housing");
    expect(debit("PAYMENT TO JOHN").category).toBe("transfers");
  });

  it("only treats SALARY as income on credits; a salary debit is money you paid out", () => {
    expect(credit("SALARY ACME CORP").category).toBe("income");
    expect(debit("SALARY DOMESTIC WORKER").category).toBe("transfers");
  });
});

describe("categoriseTransaction — Investec transactionType", () => {
  it("FeesAndInterest always wins, even with a merchant-looking description", () => {
    const r = debit("WOOLWORTHS CARD FEE", { transactionType: "FeesAndInterest" });
    expect(r.category).toBe("fees_interest");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.reason).toContain("FeesAndInterest");
  });

  it("ATMWithdrawals always maps to cash", () => {
    expect(debit("SANDTON CITY", { transactionType: "ATMWithdrawals" }).category).toBe("cash");
  });

  it("Deposits is a fallback for otherwise-unrecognised credits", () => {
    const r = credit("ZXQ 88213", { transactionType: "Deposits" });
    expect(r.category).toBe("income");
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("FasterPay / OnlineBankingPayments fall back to transfers with low confidence", () => {
    expect(debit("J SMITH", { transactionType: "FasterPay" }).category).toBe("transfers");
    const r = debit("REF 12345", { transactionType: "OnlineBankingPayments" });
    expect(r.category).toBe("transfers");
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it("does not let a soft type override a keyword match", () => {
    expect(debit("NETFLIX.COM", { transactionType: "CardPurchases" }).category).toBe("subscriptions");
    expect(debit("SUNSET APARTMENTS RENT", { transactionType: "FasterPay" }).category).toBe("rent_housing");
  });
});

describe("categoriseTransaction — MCC", () => {
  it("uses the MCC when no keyword matches", () => {
    const r = debit("ZXQ TRADING 88213", { mcc: "5411" });
    expect(r.category).toBe("groceries");
    expect(r.reason).toContain("MCC 5411");
    expect(debit("ZXQ 1", { mcc: "5812" }).category).toBe("eating_out");
    expect(debit("ZXQ 1", { mcc: "5541" }).category).toBe("transport_fuel");
    expect(debit("ZXQ 1", { mcc: "5912" }).category).toBe("health");
    expect(debit("ZXQ 1", { mcc: "6300" }).category).toBe("insurance");
  });

  it("keywords beat the MCC when both are present", () => {
    expect(debit("WOOLWORTHS", { mcc: "5812" }).category).toBe("groceries");
  });

  it("ignores unknown or malformed MCCs", () => {
    expect(debit("ZXQ 1", { mcc: "0000" }).category).toBe("other");
    expect(debit("ZXQ 1", { mcc: "abc" }).category).toBe("other");
  });
});

describe("categoriseTransaction — fallbacks", () => {
  it("unknown debits are 'other' with low confidence and an honest reason", () => {
    const r = debit("ZXQ 88213");
    expect(r.category).toBe("other");
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.reason).toMatch(/no rule matched/i);
  });

  it("unknown credits are assumed income with low confidence", () => {
    const r = credit("ZXQ 88213");
    expect(r.category).toBe("income");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("handles empty descriptions", () => {
    expect(debit("").category).toBe("other");
    expect(credit("", { merchantName: null }).category).toBe("income");
  });
});

describe("rule table integrity", () => {
  it("every rule uses a known category and has a label", () => {
    for (const rule of KEYWORD_RULES) {
      expect(CATEGORIES).toContain(rule.category);
      expect(rule.keywords.length).toBeGreaterThan(0);
    }
    for (const rule of MCC_RULES) {
      expect(CATEGORIES).toContain(rule.category);
      expect(rule.from).toBeLessThanOrEqual(rule.to);
    }
    for (const c of CATEGORIES) expect(CATEGORY_LABELS[c]).toBeTruthy();
  });

  it("always returns a known category and a bounded confidence", () => {
    const inputs = ["", "x", "WOOLWORTHS", "123 456", "PAYMENT"];
    for (const description of inputs) {
      for (const amountCents of [-100, 100]) {
        const r = categoriseTransaction({ description, amountCents });
        expect(CATEGORIES).toContain(r.category);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
        expect(r.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
