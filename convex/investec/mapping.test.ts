import { describe, expect, it } from "vitest";
import {
  beneficiaryDateToIso,
  buildBeneficiaryIndex,
  parseBeneficiaryAmount,
  resolveBeneficiaryName,
} from "./beneficiaries";
import type { InvestecBeneficiary } from "./client";
import {
  assignTransactionIds,
  deriveAmountCents,
  deriveMerchantName,
  derivePostedAtMs,
  deriveTransactionId,
  normaliseDescription,
} from "./mapping";

// Shapes copied from real sandbox responses (docs/investec-api.md).
const cardPurchase = {
  accountId: "3353431574710163189587446",
  type: "DEBIT",
  transactionType: "CardPurchases",
  status: "POSTED",
  description: "SASOL KURUMAN MANOR KURUMAN MAN ZA",
  cardNumber: "402261xxxxxx0018",
  postedOrder: 10600,
  postingDate: "2026-06-20",
  valueDate: "2026-07-31",
  actionDate: "2026-09-17",
  transactionDate: "2026-06-18",
  amount: 237.29,
  runningBalance: 9762.71,
  uuid: "87446202606200010600",
};

describe("deriveTransactionId / assignTransactionIds", () => {
  it("prefers Investec's uuid when present", () => {
    expect(deriveTransactionId(cardPurchase)).toBe("87446202606200010600");
  });

  it("falls back to a stable content hash that ignores postedOrder", () => {
    const { uuid: _uuid, ...noUuid } = cardPurchase;
    const a = deriveTransactionId(noUuid);
    const b = deriveTransactionId({ ...noUuid, postedOrder: 99999 });
    expect(a).toBe(b);
    expect(a).toMatch(/^3353431574710163189587446-2026-06-18-[0-9a-f]+$/u);
    // Different amount => different id.
    expect(deriveTransactionId({ ...noUuid, amount: 1 })).not.toBe(a);
  });

  it("keeps rows that share one uuid distinct (sandbox savings products)", () => {
    // Real sandbox quirk: three PrimeSaver rows all carry uuid
    // "82963202701020000000" and postedOrder 0.
    const shared = {
      accountId: "3353431574710166878182963",
      uuid: "82963202701020000000",
      postingDate: "2027-01-02",
      postedOrder: 0,
    };
    const rows = [
      { ...shared, transactionDate: "2026-07-18", amount: 5.5, description: "Interest Value Date 01Sep22" },
      { ...shared, transactionDate: "2026-08-08", amount: 10, description: "Transfer from Card Internet ... API transfer" },
      { ...shared, transactionDate: "2026-08-10", amount: 10, description: "Transfer from Card Internet ... API transfer" },
    ];
    const ids = assignTransactionIds(rows);
    expect(new Set(ids).size).toBe(3);
    // First occurrence keeps the bare uuid so previously stored rows stay stable.
    expect(ids[0]).toBe("82963202701020000000");
    expect(ids[1]).toMatch(/^82963202701020000000~[0-9a-f]+$/u);
    // Deterministic across syncs.
    expect(assignTransactionIds(rows)).toEqual(ids);
  });

  it("disambiguates fully identical duplicate rows with a counter", () => {
    const row = { accountId: "a", uuid: "u", transactionDate: "2026-01-01", amount: 1, description: "x" };
    const ids = assignTransactionIds([row, { ...row }, { ...row }]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("deriveAmountCents", () => {
  it("negates debits and keeps credits positive, in integer cents", () => {
    expect(deriveAmountCents(237.29, "DEBIT")).toBe(-23729);
    expect(deriveAmountCents(29659.92, "CREDIT")).toBe(2965992);
    expect(deriveAmountCents(0.1 + 0.2, "CREDIT")).toBe(30);
    expect(deriveAmountCents(5, null)).toBe(500);
  });
});

describe("derivePostedAtMs", () => {
  const SAST = 2 * 60 * 60 * 1000;
  it("prefers transactionDate over the (often future-dated) postingDate", () => {
    expect(derivePostedAtMs(cardPurchase)).toBe(Date.UTC(2026, 5, 18) - SAST);
  });
  it("falls back actionDate -> valueDate -> postingDate", () => {
    expect(derivePostedAtMs({ actionDate: "2026-09-17", postingDate: "2027-01-02" })).toBe(
      Date.UTC(2026, 8, 17) - SAST,
    );
    expect(derivePostedAtMs({ valueDate: "2026-07-31", postingDate: "2027-01-02" })).toBe(
      Date.UTC(2026, 6, 31) - SAST,
    );
    expect(derivePostedAtMs({ postingDate: "2027-01-02" })).toBe(Date.UTC(2027, 0, 2) - SAST);
  });
  it("tolerates null fields (sandbox returns valueDate: null)", () => {
    expect(derivePostedAtMs({ transactionDate: "2026-07-18", valueDate: null, postingDate: null })).toBe(
      Date.UTC(2026, 6, 18) - SAST,
    );
  });
  it("never returns NaN when no date is present", () => {
    const before = Date.now();
    const ms = derivePostedAtMs({});
    expect(ms).toBeGreaterThanOrEqual(before);
  });
});

describe("descriptions", () => {
  it("collapses padded whitespace from the pending endpoint", () => {
    expect(normaliseDescription("Amazon Retail            Lagos        ZA")).toBe("Amazon Retail Lagos ZA");
    expect(normaliseDescription(null)).toBe("");
  });
  it("strips the trailing country code when deriving a merchant", () => {
    expect(deriveMerchantName("YOCO   *ARUKAH HEALTH KURUMAN ZA")).toBe("YOCO *ARUKAH HEALTH KURUMAN");
    expect(deriveMerchantName("VODACOM 0397")).toBe("VODACOM 0397");
  });
});

describe("beneficiary enrichment", () => {
  const sandboxLike: InvestecBeneficiary[] = [
    {
      beneficiaryId: "MTAxODk2ODk0MTQ5NzM=",
      accountNumber: "62023254303",
      code: "250655",
      bank: "FIRST NATIONAL BANK",
      beneficiaryName: null,
      lastPaymentAmount: "2.50",
      lastPaymentDate: "22/11/2022",
      name: "FNB Ben",
      referenceName: null, // sandbox: most beneficiaries have no referenceName
      referenceAccountNumber: "FNB Ben Ref",
    },
    {
      beneficiaryId: "b2",
      accountNumber: "1",
      code: "1",
      bank: "X",
      beneficiaryName: "City of Kuruman (Pty) Ltd",
      name: "Kuruman Municipality",
      referenceName: "CITY OF KURUMAN - PARTRIDGE",
      lastPaymentAmount: "865.00",
      lastPaymentDate: "09/09/2026",
    },
    {
      beneficiaryId: "b3",
      accountNumber: "2",
      code: "1",
      bank: "X",
      beneficiaryName: null,
      name: "Contractor A",
      referenceName: "499 MAINTENANCE",
      lastPaymentAmount: "10,000.00",
      lastPaymentDate: "05/10/2022",
    },
    {
      beneficiaryId: "b4",
      accountNumber: "3",
      code: "1",
      bank: "X",
      beneficiaryName: null,
      name: "Contractor B",
      referenceName: "499 maintenance",
      lastPaymentAmount: "250.00",
      lastPaymentDate: "1/3/2023",
    },
  ];
  const index = buildBeneficiaryIndex(sandboxLike);

  it("indexes by normalised referenceName and skips beneficiaries without one", () => {
    expect(index.size).toBe(2);
    expect(index.get("CITY OF KURUMAN - PARTRIDGE")?.[0].name).toBe("Kuruman Municipality");
    expect(index.get("499 MAINTENANCE")).toHaveLength(2);
  });

  it("only touches OnlineBankingPayments and only on an exact reference match", () => {
    expect(
      resolveBeneficiaryName("OnlineBankingPayments", "CITY OF KURUMAN - PARTRIDGE", 865, "2026-09-09", index),
    ).toBe("Kuruman Municipality");
    expect(resolveBeneficiaryName("DebitOrders", "CITY OF KURUMAN - PARTRIDGE", 865, "2026-09-09", index)).toBeNull();
    expect(resolveBeneficiaryName("OnlineBankingPayments", "CITY OF KURUMAN - KURUMAN", 370, null, index)).toBeNull();
    expect(resolveBeneficiaryName("OnlineBankingPayments", "SMITH", 2, null, undefined)).toBeNull();
  });

  it("tiebreaks shared references on last payment amount + date, else stays silent", () => {
    expect(resolveBeneficiaryName("OnlineBankingPayments", "499 MAINTENANCE", 10000, "2022-10-05", index)).toBe(
      "Contractor A",
    );
    expect(resolveBeneficiaryName("OnlineBankingPayments", "499 MAINTENANCE", 250, "2023-03-01", index)).toBe(
      "Contractor B",
    );
    expect(resolveBeneficiaryName("OnlineBankingPayments", "499 MAINTENANCE", 250, "2024-01-01", index)).toBeNull();
  });

  it("parses Investec's formatted amounts and dates", () => {
    expect(parseBeneficiaryAmount("10,000.00")).toBe(10000);
    expect(parseBeneficiaryAmount("0.00")).toBe(0);
    expect(parseBeneficiaryAmount(null)).toBeNull();
    expect(beneficiaryDateToIso("05/10/2022")).toBe("2022-10-05");
    expect(beneficiaryDateToIso("1/3/2023")).toBe("2023-03-01");
    expect(beneficiaryDateToIso("Never been Paid")).toBeNull();
  });
});
