import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { createTestBackend } from "../test.setup";

/**
 * End-to-end sync against an in-memory Convex backend and a fake Investec
 * sandbox served by a stubbed global `fetch`. Payloads mirror what the real
 * sandbox returned on 2026-09-17 (see docs/investec-api.md), including its
 * quirks: null transactionType + shared uuid on savings rows, padded pending
 * descriptions, and a pending endpoint that 500s for non-main accounts.
 */

const MAIN = "3353431574710163189587446";
const SAVER = "3353431574710166878182963";

const accountsBody = {
  data: {
    accounts: [
      {
        accountId: MAIN,
        accountNumber: "10011425044",
        accountName: "Mr Smith",
        referenceName: "Mr Smith Main",
        productName: "Private Bank Account",
        kycCompliant: true,
        profileId: "10163189587444",
        profileName: "Profile A",
      },
      {
        accountId: SAVER,
        accountNumber: "1100470321500",
        accountName: "Mr Smith",
        referenceName: "Mr Smith Prime",
        productName: "PrimeSaver",
        kycCompliant: true,
        profileId: "10163189587444",
        profileName: "Profile A",
      },
    ],
  },
  links: { self: "https://openapisandbox.investec.com/za/pb/v1/accounts" },
  meta: { totalPages: 1 },
};

const mainTransactions = [
  {
    accountId: MAIN,
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
  },
  {
    accountId: MAIN,
    type: "DEBIT",
    transactionType: "DebitOrders",
    status: "POSTED",
    description: "VODACOM 0397",
    cardNumber: "",
    postedOrder: 10674,
    postingDate: "2026-07-03",
    valueDate: "2026-07-03",
    actionDate: "2026-09-17",
    transactionDate: "2026-07-03",
    amount: 400.73,
    runningBalance: 30477.36,
    uuid: "87446202607030010674",
  },
  {
    accountId: MAIN,
    type: "DEBIT",
    transactionType: "OnlineBankingPayments",
    status: "POSTED",
    description: "CITY OF KURUMAN - PARTRIDGE",
    cardNumber: "",
    postedOrder: 11000,
    postingDate: "2026-09-09",
    valueDate: "2026-09-09",
    actionDate: "2026-09-17",
    transactionDate: "2026-09-09",
    amount: 865,
    runningBalance: 34000,
    uuid: "87446202609090011000",
  },
  {
    accountId: MAIN,
    type: "CREDIT",
    transactionType: "Deposits",
    status: "POSTED",
    description: "STANCOM 352Kjoe.smith",
    cardNumber: "",
    postedOrder: 11010,
    postingDate: "2026-09-16",
    valueDate: "2026-09-16",
    actionDate: "2026-09-17",
    transactionDate: "2026-09-16",
    amount: 29733.26,
    runningBalance: 33607.16,
    uuid: "87446202609160011010",
  },
];

// Real sandbox quirk: identical uuid + postedOrder 0 + null transactionType.
const saverTransactions = [
  {
    accountId: SAVER,
    type: "CREDIT",
    transactionType: null,
    status: "POSTED",
    description: "Interest Value Date 01Sep22",
    cardNumber: "",
    postedOrder: 0,
    postingDate: "2027-01-02",
    valueDate: null,
    actionDate: "2026-09-17",
    transactionDate: "2026-07-18",
    amount: 5.5,
    runningBalance: 1281.05,
    uuid: "82963202701020000000",
  },
  {
    accountId: SAVER,
    type: "CREDIT",
    transactionType: null,
    status: "POSTED",
    description: "Transfer from Card Internet Value Date 21Sep22 UBP0101067062 10011425044 API transfer",
    cardNumber: "",
    postedOrder: 0,
    postingDate: "2027-01-02",
    valueDate: null,
    actionDate: "2026-09-17",
    transactionDate: "2026-08-08",
    amount: 10,
    runningBalance: 1291.05,
    uuid: "82963202701020000000",
  },
];

const pendingBody = {
  data: {
    transactions: [
      {
        accountId: MAIN,
        type: "DEBIT",
        status: "PENDING",
        description: "Amazon Retail            Lagos        ZA",
        transactionDate: "2026-09-17",
        amount: 999,
      },
      {
        accountId: MAIN,
        type: "DEBIT",
        status: "PENDING",
        description: "YOUTUBE       GP           ZA",
        transactionDate: "2026-09-17",
        amount: 110,
      },
    ],
  },
};

const beneficiariesBody = {
  data: [
    {
      beneficiaryId: "MTAxODk2ODk0MTQ5NzM=",
      accountNumber: "62023254303",
      code: "250655",
      bank: "FIRST NATIONAL BANK",
      beneficiaryName: null,
      lastPaymentAmount: "2.50",
      lastPaymentDate: "22/11/2022",
      name: "FNB Ben",
      referenceName: null,
    },
    {
      beneficiaryId: "b2",
      accountNumber: "1",
      code: "1",
      bank: "X",
      beneficiaryName: null,
      lastPaymentAmount: "865.00",
      lastPaymentDate: "09/09/2026",
      name: "Kuruman Municipality",
      referenceName: "CITY OF KURUMAN - PARTRIDGE",
    },
  ],
};

type Overrides = {
  saverBalanceStatus?: number;
  mainTransactions?: typeof mainTransactions;
};

const seen: { url: string; init?: RequestInit }[] = [];

function installFakeSandbox(overrides: Overrides = {}) {
  seen.length = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push({ url, init });
    const u = new URL(url);
    const p = u.pathname;
    if (p === "/identity/v2/oauth2/token") {
      return json({ access_token: "tok", token_type: "Bearer", expires_in: 1799, scope: "accounts" });
    }
    if (p === "/za/pb/v1/accounts") return json(accountsBody);
    if (p === "/za/pb/v1/accounts/beneficiaries") return json(beneficiariesBody);
    if (p === `/za/pb/v1/accounts/${MAIN}/transactions`) {
      return json({ data: { transactions: overrides.mainTransactions ?? mainTransactions }, meta: { totalPages: 1 } });
    }
    if (p === `/za/pb/v1/accounts/${SAVER}/transactions`) {
      return json({ data: { transactions: saverTransactions }, meta: { totalPages: 1 } });
    }
    if (p === `/za/pb/v1/accounts/${MAIN}/balance`) {
      return json({
        data: { accountId: MAIN, currentBalance: 33607.16, availableBalance: 33000.5, budgetBalance: 0, currency: "ZAR" },
      });
    }
    if (p === `/za/pb/v1/accounts/${SAVER}/balance`) {
      if (overrides.saverBalanceStatus && overrides.saverBalanceStatus !== 200) {
        return new Response("The specified account is invalid. (Parameter 'accountId')", {
          status: overrides.saverBalanceStatus,
        });
      }
      return json({ data: { accountId: SAVER, currentBalance: 1364.21, availableBalance: 1364.21, currency: "ZAR" } });
    }
    if (p === `/za/pb/v1/accounts/${MAIN}/pending-transactions`) return json(pendingBody);
    if (p === `/za/pb/v1/accounts/${SAVER}/pending-transactions`) {
      // Non-retryable in the fake so the test stays fast; the real sandbox
      // returns 500 here (covered by the retry tests in client.test.ts).
      return json({ type: "https://tools.ietf.org/html/rfc9110#section-15.6.1", title: "An error occurred" }, 404);
    }
    return new Response(`unexpected ${url}`, { status: 418 });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => {
  vi.stubEnv("INVESTEC_BASE_URL", "https://openapisandbox.investec.com");
  vi.stubEnv("INVESTEC_CLIENT_ID", "test-id");
  vi.stubEnv("INVESTEC_CLIENT_SECRET", "test-secret");
  vi.stubEnv("INVESTEC_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("internal.investec.sync.run (stubbed sandbox)", () => {
  it("persists transactions with transactionType/status, balances with source, pending snapshot and beneficiary names", async () => {
    installFakeSandbox();
    const t = createTestBackend();

    const result = await t.action(internal.investec.sync.run, { triggeredBy: "manual" });
    expect(result).toMatchObject({
      accountsSynced: 2,
      transactionsInserted: mainTransactions.length + saverTransactions.length,
      transactionsUpdated: 0,
      pendingSynced: 2,
      balanceFromEndpoint: 2,
      balanceFromRunningBalance: 0,
      beneficiariesLoaded: 2,
      beneficiaryMatches: 1,
      apiHost: "openapisandbox.investec.com",
    });
    expect(result.warnings?.some((w) => w.includes("pending endpoint unavailable for 1100470321500"))).toBe(true);

    // Default backfill window is 365 days.
    const txCall = seen.find((c) => c.url.includes(`/accounts/${MAIN}/transactions`))!;
    const qs = new URL(txCall.url).searchParams;
    const spanDays = (Date.parse(qs.get("toDate")!) - Date.parse(qs.get("fromDate")!)) / 86_400_000;
    expect(spanDays).toBe(365);

    const rows = await t.run(async (ctx) => {
      const accounts = await ctx.db.query("accounts").collect();
      const main = accounts.find((a) => a.investecAccountId === MAIN)!;
      const saver = accounts.find((a) => a.investecAccountId === SAVER)!;
      const txs = await ctx.db
        .query("transactions")
        .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", main._id))
        .collect();
      const saverTxs = await ctx.db
        .query("transactions")
        .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", saver._id))
        .collect();
      const pending = await ctx.db
        .query("pendingTransactions")
        .withIndex("by_account", (q) => q.eq("accountId", main._id))
        .collect();
      const runs = await ctx.db.query("syncRuns").collect();
      return { main, saver, txs, saverTxs, pending, runs };
    });

    // Account: authoritative balance endpoint wins, both balances stored.
    expect(rows.main.name).toBe("Mr Smith Main");
    expect(rows.main.balanceSource).toBe("balance_endpoint");
    expect(rows.main.currentBalanceCents).toBe(3360716);
    expect(rows.main.availableBalanceCents).toBe(3300050);
    expect(rows.main.currency).toBe("ZAR");
    expect(rows.main.balanceAsOf).toBeGreaterThan(0);

    // Transactions carry Investec's transactionType/status + signed cents.
    const vodacom = rows.txs.find((x) => x.description === "VODACOM 0397")!;
    expect(vodacom).toMatchObject({ transactionType: "DebitOrders", status: "POSTED", amountCents: -40073, type: "DEBIT" });
    const salary = rows.txs.find((x) => x.description.startsWith("STANCOM"))!;
    expect(salary).toMatchObject({ transactionType: "Deposits", amountCents: 2973326, runningBalanceCents: 3360716 });
    // transactionDate (18 Jun) is preferred over postingDate (20 Jun).
    const sasol = rows.txs.find((x) => x.description.startsWith("SASOL"))!;
    expect(new Date(sasol.postedAt).toISOString().slice(0, 10)).toBe("2026-06-17"); // 2026-06-18 00:00 SAST in UTC

    // OnlineBankingPayments relabelled with the saved beneficiary's name; raw description kept.
    const municipal = rows.txs.find((x) => x.description === "CITY OF KURUMAN - PARTRIDGE")!;
    expect(municipal.merchantName).toBe("Kuruman Municipality");
    expect(municipal.transactionType).toBe("OnlineBankingPayments");

    // Savings rows sharing a uuid are both kept; null transactionType is omitted, not stored as null.
    expect(rows.saverTxs).toHaveLength(2);
    expect(rows.saverTxs.every((x) => x.transactionType === undefined)).toBe(true);
    expect(rows.saver.balanceSource).toBe("balance_endpoint");

    // Pending snapshot: signed cents, normalised description, expected date.
    expect(rows.pending).toHaveLength(2);
    const amazon = rows.pending.find((p) => p.description.startsWith("Amazon"))!;
    expect(amazon.description).toBe("Amazon Retail Lagos ZA");
    expect(amazon.amountCents).toBe(-99900);
    expect(new Date(amazon.expectedAt).toISOString().slice(0, 10)).toBe("2026-09-16");

    // Sync run audit row.
    expect(rows.runs).toHaveLength(1);
    expect(rows.runs[0]).toMatchObject({ status: "success", triggeredBy: "manual", accountsSynced: 2 });
    expect(rows.runs[0].finishedAt).toBeGreaterThanOrEqual(rows.runs[0].startedAt);

    // Every endpoint in the provenance list was actually called.
    const paths = new Set(seen.map((c) => new URL(c.url).pathname));
    expect(paths.has("/identity/v2/oauth2/token")).toBe(true);
    expect(paths.has("/za/pb/v1/accounts")).toBe(true);
    expect(paths.has("/za/pb/v1/accounts/beneficiaries")).toBe(true);
    expect(paths.has(`/za/pb/v1/accounts/${MAIN}/balance`)).toBe(true);
    expect(paths.has(`/za/pb/v1/accounts/${MAIN}/pending-transactions`)).toBe(true);
    // Token fetched once and reused across all calls.
    expect(seen.filter((c) => c.url.includes("/oauth2/token"))).toHaveLength(1);
  });

  it("re-syncs idempotently with a 3-day overlap window and replaces the pending snapshot", async () => {
    installFakeSandbox();
    const t = createTestBackend();
    await t.action(internal.investec.sync.run, { triggeredBy: "cron" });
    seen.length = 0;

    const second = await t.action(internal.investec.sync.run, { triggeredBy: "cron" });
    expect(second.transactionsInserted).toBe(0);
    expect(second.transactionsUpdated).toBe(mainTransactions.length + saverTransactions.length);

    const txCall = seen.find((c) => c.url.includes(`/accounts/${MAIN}/transactions`))!;
    const from = new URL(txCall.url).searchParams.get("fromDate")!;
    // newest main tx is 2026-09-16 (SAST) -> minus 3 days.
    expect(from).toBe("2026-09-12");

    const counts = await t.run(async (ctx) => ({
      txs: (await ctx.db.query("transactions").collect()).length,
      pending: (await ctx.db.query("pendingTransactions").collect()).length,
      runs: (await ctx.db.query("syncRuns").collect()).length,
    }));
    expect(counts.txs).toBe(mainTransactions.length + saverTransactions.length);
    expect(counts.pending).toBe(2); // replaced, not appended
    expect(counts.runs).toBe(2);
  });

  it("falls back to the newest runningBalance when the balance endpoint fails", async () => {
    installFakeSandbox({ saverBalanceStatus: 400 });
    const t = createTestBackend();
    const result = await t.action(internal.investec.sync.run, { triggeredBy: "manual" });
    expect(result.balanceFromEndpoint).toBe(1);
    expect(result.balanceFromRunningBalance).toBe(1);
    expect(result.warnings?.some((w) => w.startsWith("balance endpoint failed for 1100470321500"))).toBe(true);

    const saver = await t.run(async (ctx) =>
      (await ctx.db.query("accounts").collect()).find((a) => a.investecAccountId === SAVER)!,
    );
    expect(saver.balanceSource).toBe("running_balance");
    expect(saver.currentBalanceCents).toBe(129105); // newest by transactionDate (2026-08-08)
    expect(saver.availableBalanceCents).toBeUndefined();
  });

  it("records an error run and rethrows when the API is unreachable", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    const t = createTestBackend();
    await expect(t.action(internal.investec.sync.run, { triggeredBy: "manual" })).rejects.toThrow(/403/u);
    const runs = await t.run(async (ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toMatch(/403/u);
  });

  it("refuses to start while another run is in progress, but reaps stale runs", async () => {
    const t = createTestBackend();
    await t.run(async (ctx) => {
      await ctx.db.insert("syncRuns", {
        startedAt: Date.now() - 60_000,
        status: "running",
        triggeredBy: "cron",
        accountsSynced: 0,
        transactionsInserted: 0,
        transactionsUpdated: 0,
      });
    });
    await expect(t.mutation(internal.investec.mutations.startSyncRun, { triggeredBy: "manual" })).rejects.toThrow(
      /still running/u,
    );

    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("syncRuns").collect()) {
        await ctx.db.patch(r._id, { startedAt: Date.now() - 45 * 60_000 });
      }
    });
    await t.mutation(internal.investec.mutations.startSyncRun, { triggeredBy: "manual" });
    const runs = await t.run(async (ctx) => ctx.db.query("syncRuns").order("asc").collect());
    expect(runs[0]).toMatchObject({ status: "error", error: "stale: run did not finish" });
    expect(runs[1].status).toBe("running");
  });
});

describe("api.investec.status.get", () => {
  it("reports provenance for a synced Investec account", async () => {
    installFakeSandbox();
    const t = createTestBackend();
    await t.action(internal.investec.sync.run, { triggeredBy: "manual" });

    const status = await t.query(api.investec.status.get, {});
    expect(status.dataSource).toBe("investec");
    expect(status.environment).toBe("sandbox");
    expect(status.apiHost).toBe("openapisandbox.investec.com");
    expect(status.syncInProgress).toBe(false);
    expect(status.lastRun).toMatchObject({ status: "success", triggeredBy: "manual", accountsSynced: 2 });
    expect(status.lastSuccessfulRun?.finishedAt).not.toBeNull();
    expect(status.endpoints.map((e) => e.path)).toContain("/za/pb/v1/accounts/{accountId}/balance");

    const main = status.account!;
    expect(main.name).toBe("Mr Smith Main");
    expect(main.balanceSource).toBe("balance_endpoint");
    expect(main.availableBalanceCents).toBe(3300050);
    expect(main.transactionCount).toBe(mainTransactions.length);
    expect(main.transactionCountCapped).toBe(false);
    expect(main.transactionTypeCoverage).toBe(1);
    expect(main.pendingCount).toBe(2);
    expect(main.pendingTotalCents).toBe(-110900);
    expect(new Date(main.oldestTransactionAt!).toISOString().slice(0, 10)).toBe("2026-06-17");
    expect(new Date(main.newestTransactionAt!).toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("labels the seeded demo account as synthetic and handles an empty deployment", async () => {
    const t = createTestBackend();
    const empty = await t.query(api.investec.status.get, {});
    expect(empty).toMatchObject({ dataSource: "none", account: null, lastRun: null, syncInProgress: false });

    const { accountId } = await t.mutation(api.seed.seedDemoAccount, {});
    const status = await t.query(api.investec.status.get, { accountId });
    expect(status.dataSource).toBe("synthetic");
    expect(status.account?.balanceSource).toBe("synthetic");
    expect(status.account?.transactionCount).toBeGreaterThan(50);
  });

  it("reports unknown environment when INVESTEC_BASE_URL is unset", async () => {
    vi.stubEnv("INVESTEC_BASE_URL", "");
    const t = createTestBackend();
    const status = await t.query(api.investec.status.get, {});
    expect(status.environment).toBe("unknown");
    expect(status.apiHost).toBeNull();
  });
});
