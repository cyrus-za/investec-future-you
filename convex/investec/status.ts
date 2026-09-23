import { v } from "convex/values";
import { query } from "../_generated/server";
import { classifyEnvironment, hostFromBaseUrl } from "./client";

/** Upper bound on rows scanned when counting an account's transactions. */
const COUNT_CAP = 5000;

/**
 * Every Investec endpoint this app calls, and what each one feeds. This is a
 * static description of the code path in sync.ts — it is what the
 * provenance tooltip shows, so keep it in step with the client.
 */
export const ENDPOINTS_USED = [
  {
    method: "POST",
    path: "/identity/v2/oauth2/token",
    purpose: "OAuth2 client_credentials token (cached until ~1 min before expiry)",
  },
  {
    method: "GET",
    path: "/za/pb/v1/accounts",
    purpose: "Account list: id, number, referenceName/productName → account picker",
  },
  {
    method: "GET",
    path: "/za/pb/v1/accounts/{accountId}/transactions?fromDate&toDate",
    purpose:
      "Posted transactions (365-day backfill, then 3-day overlap): amount, type, transactionType, dates, runningBalance → history, recurring detection, forecast",
  },
  {
    method: "GET",
    path: "/za/pb/v1/accounts/{accountId}/balance",
    purpose: "currentBalance + availableBalance → forecast starting point (falls back to runningBalance)",
  },
  {
    method: "GET",
    path: "/za/pb/v1/accounts/{accountId}/pending-transactions",
    purpose: "Not-yet-posted card holds → near-certain upcoming debits (best-effort; sandbox only serves one account)",
  },
  {
    method: "GET",
    path: "/za/pb/v1/accounts/beneficiaries",
    purpose: "Saved payees → label OnlineBankingPayments with the beneficiary name when the reference matches",
  },
] as const;

const endpointValidator = v.object({ method: v.string(), path: v.string(), purpose: v.string() });

const lastRunValidator = v.object({
  status: v.union(v.literal("running"), v.literal("success"), v.literal("error")),
  triggeredBy: v.union(v.literal("cron"), v.literal("manual")),
  startedAt: v.number(),
  finishedAt: v.union(v.number(), v.null()),
  accountsSynced: v.number(),
  transactionsInserted: v.number(),
  transactionsUpdated: v.number(),
  error: v.union(v.string(), v.null()),
});

const accountStatusValidator = v.object({
  accountId: v.id("accounts"),
  name: v.string(),
  currency: v.string(),
  /** "synthetic" for the seeded demo account, otherwise the Investec source. */
  balanceSource: v.union(
    v.literal("balance_endpoint"),
    v.literal("running_balance"),
    v.literal("synthetic"),
    v.literal("unknown"),
  ),
  balanceAsOf: v.union(v.number(), v.null()),
  currentBalanceCents: v.union(v.number(), v.null()),
  availableBalanceCents: v.union(v.number(), v.null()),
  transactionCount: v.number(),
  transactionCountCapped: v.boolean(),
  oldestTransactionAt: v.union(v.number(), v.null()),
  newestTransactionAt: v.union(v.number(), v.null()),
  pendingCount: v.number(),
  pendingTotalCents: v.number(),
  pendingUpdatedAt: v.union(v.number(), v.null()),
  transactionTypeCoverage: v.number(), // 0..1 share of rows carrying transactionType
});

export const statusValidator = v.object({
  dataSource: v.union(v.literal("investec"), v.literal("synthetic"), v.literal("none")),
  environment: v.union(v.literal("sandbox"), v.literal("production"), v.literal("unknown")),
  apiHost: v.union(v.string(), v.null()),
  syncInProgress: v.boolean(),
  lastRun: v.union(lastRunValidator, v.null()),
  lastSuccessfulRun: v.union(lastRunValidator, v.null()),
  account: v.union(accountStatusValidator, v.null()),
  endpoints: v.array(endpointValidator),
});

const DEMO_ACCOUNT_ID = "demo-synthetic-account";

/**
 * Data-provenance summary for the UI: where the numbers came from, when, and
 * how complete they are. No wall-clock reads here (the client renders
 * "synced N min ago" from `finishedAt`).
 *
 * The sandbox-vs-production flag is derived from INVESTEC_BASE_URL, which
 * Convex exposes to queries via process.env; if it is not set the UI says
 * "unknown" rather than guessing.
 */
export const get = query({
  args: { accountId: v.optional(v.id("accounts")) },
  returns: statusValidator,
  handler: async (ctx, args) => {
    const apiHost = hostFromBaseUrl(
      typeof process !== "undefined" ? process.env.INVESTEC_BASE_URL : undefined,
    );

    const recentRuns = await ctx.db.query("syncRuns").order("desc").take(10);
    const toRun = (r: (typeof recentRuns)[number]) => ({
      status: r.status,
      triggeredBy: r.triggeredBy,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      accountsSynced: r.accountsSynced,
      transactionsInserted: r.transactionsInserted,
      transactionsUpdated: r.transactionsUpdated,
      error: r.error ?? null,
    });
    const lastRun = recentRuns[0] ? toRun(recentRuns[0]) : null;
    const lastSuccess = recentRuns.find((r) => r.status === "success");
    const lastSuccessfulRun = lastSuccess ? toRun(lastSuccess) : null;

    const account = args.accountId
      ? await ctx.db.get(args.accountId)
      : await ctx.db.query("accounts").first();

    let accountStatus = null;
    let dataSource: "investec" | "synthetic" | "none" = "none";
    if (account) {
      const isSynthetic =
        account.investecAccountId === DEMO_ACCOUNT_ID || account.balanceSource === "synthetic";
      dataSource = isSynthetic ? "synthetic" : "investec";

      // Convex query builders are single-use, so build one per read.
      const byAccount = () =>
        ctx.db
          .query("transactions")
          .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", account._id));
      const oldest = await byAccount().order("asc").first();
      const newest = await byAccount().order("desc").first();
      const rows = await byAccount().take(COUNT_CAP);
      const withType = rows.filter((r) => !!r.transactionType).length;

      const pending = await ctx.db
        .query("pendingTransactions")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .take(500);

      accountStatus = {
        accountId: account._id,
        name: account.name,
        currency: account.currency,
        balanceSource: isSynthetic ? ("synthetic" as const) : (account.balanceSource ?? ("unknown" as const)),
        balanceAsOf: account.balanceAsOf ?? null,
        currentBalanceCents: account.currentBalanceCents ?? null,
        availableBalanceCents: account.availableBalanceCents ?? null,
        transactionCount: rows.length,
        transactionCountCapped: rows.length >= COUNT_CAP,
        oldestTransactionAt: oldest?.postedAt ?? null,
        newestTransactionAt: newest?.postedAt ?? null,
        pendingCount: pending.length,
        pendingTotalCents: pending.reduce((sum, p) => sum + p.amountCents, 0),
        pendingUpdatedAt: pending.reduce<number | null>(
          (max, p) => (max === null || p.updatedAt > max ? p.updatedAt : max),
          null,
        ),
        transactionTypeCoverage: rows.length === 0 ? 0 : withType / rows.length,
      };
    }

    return {
      dataSource,
      environment: classifyEnvironment(apiHost),
      apiHost,
      syncInProgress: lastRun?.status === "running",
      lastRun,
      lastSuccessfulRun,
      account: accountStatus,
      endpoints: ENDPOINTS_USED.map((e) => ({ ...e })),
    };
  },
});
