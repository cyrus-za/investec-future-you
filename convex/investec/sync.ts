import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { DAY_MS, msToIsoDate } from "../lib/dates";
import { buildBeneficiaryIndex, resolveBeneficiaryName, type BeneficiaryIndex } from "./beneficiaries";
import { InvestecClient, type InvestecAccount, type TokenCache } from "./client";
import {
  assignTransactionIds,
  deriveAmountCents,
  deriveMerchantName,
  derivePostedAtMs,
  normaliseDescription,
} from "./mapping";

/**
 * How far back a first sync reaches. The transactions endpoint accepts any
 * window (a 2020-01-01 fromDate is fine) and simply returns what exists; the
 * sandbox only holds ~3 months of card history, so 365 days costs nothing
 * extra there while giving real accounts a full year for recurring detection.
 */
export const DEFAULT_BACKFILL_DAYS = 365;
/** Hard cap so a typo can't request decades of history in one call. */
export const MAX_BACKFILL_DAYS = 730;
/** Re-pull the last few days on every incremental sync so late-posting rows
 * (postingDate lags transactionDate by up to ~3 days) are picked up. */
export const RESYNC_OVERLAP_DAYS = 3;
const UPSERT_BATCH_SIZE = 100;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it with: npx convex env set ${name} <value>`,
    );
  }
  return value;
}

const syncResult = v.object({
  accountsSynced: v.number(),
  transactionsInserted: v.number(),
  transactionsUpdated: v.number(),
  // --- additive, optional (older callers ignore them) ---
  /** Pending rows stored across all accounts whose endpoint responded. */
  pendingSynced: v.optional(v.number()),
  /** Accounts whose balance came from GET /accounts/:id/balance. */
  balanceFromEndpoint: v.optional(v.number()),
  /** Accounts that fell back to the newest transaction's runningBalance. */
  balanceFromRunningBalance: v.optional(v.number()),
  beneficiariesLoaded: v.optional(v.number()),
  /** OnlineBankingPayments rows relabelled with a saved-beneficiary name. */
  beneficiaryMatches: v.optional(v.number()),
  apiHost: v.optional(v.string()),
  /** Non-fatal problems (e.g. pending endpoint 500 for an account). */
  warnings: v.optional(v.array(v.string())),
});

type SyncArgs = { triggeredBy: "cron" | "manual"; backfillDays?: number };
type SyncResult = {
  accountsSynced: number;
  transactionsInserted: number;
  transactionsUpdated: number;
  pendingSynced?: number;
  balanceFromEndpoint?: number;
  balanceFromRunningBalance?: number;
  beneficiariesLoaded?: number;
  beneficiaryMatches?: number;
  apiHost?: string;
  warnings?: string[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function clampBackfillDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return DEFAULT_BACKFILL_DAYS;
  return Math.min(Math.floor(days), MAX_BACKFILL_DAYS);
}

/** Display name for an account: the user's own label first. */
export function accountDisplayName(a: InvestecAccount): string {
  return a.referenceName ?? a.productName ?? a.accountName ?? `Account ${a.accountNumber}`;
}

/** Shared implementation called directly by both `run` and `runNow` below —
 * kept as a plain function (not a cross-call via ctx.runAction) so the two
 * exports in this file don't create a circular type reference through the
 * generated `internal` API object. */
async function syncAllAccounts(ctx: ActionCtx, args: SyncArgs): Promise<SyncResult> {
  // Throws if another run is genuinely in progress (see startSyncRun).
  const runId = await ctx.runMutation(internal.investec.mutations.startSyncRun, {
    triggeredBy: args.triggeredBy,
  });

  const tokenCache: TokenCache = {
    get: () => ctx.runQuery(internal.investec.token.get, {}),
    set: (token) => ctx.runMutation(internal.investec.token.set, token),
    clear: () => ctx.runMutation(internal.investec.token.clear, {}),
  };

  let accountsSynced = 0;
  let transactionsInserted = 0;
  let transactionsUpdated = 0;
  let pendingSynced = 0;
  let balanceFromEndpoint = 0;
  let balanceFromRunningBalance = 0;
  let beneficiariesLoaded = 0;
  let beneficiaryMatches = 0;
  const warnings: string[] = [];

  try {
    const client = new InvestecClient(
      {
        baseUrl: requireEnv("INVESTEC_BASE_URL"),
        clientId: requireEnv("INVESTEC_CLIENT_ID"),
        clientSecret: requireEnv("INVESTEC_CLIENT_SECRET"),
        apiKey: requireEnv("INVESTEC_API_KEY"),
      },
      tokenCache,
    );
    const apiHost = client.host;

    const accounts = await client.listAccounts();

    // Saved beneficiaries are profile-wide, so fetch once per run. Purely an
    // enrichment: a failure here must never fail the sync.
    let beneficiaryIndex: BeneficiaryIndex | undefined;
    try {
      const beneficiaries = await client.listBeneficiaries();
      beneficiariesLoaded = beneficiaries.length;
      beneficiaryIndex = buildBeneficiaryIndex(beneficiaries);
    } catch (err) {
      warnings.push(`beneficiaries unavailable: ${errorMessage(err)}`);
    }

    for (const a of accounts) {
      const accountId = await ctx.runMutation(internal.investec.mutations.upsertAccount, {
        investecAccountId: a.accountId,
        investecAccountNumber: a.accountNumber,
        name: accountDisplayName(a),
        currency: (a.currency ?? "ZAR").toUpperCase(),
      });
      accountsSynced++;

      // --- 1. Transactions -------------------------------------------------
      const lastPostedAt = await ctx.runQuery(
        internal.investec.mutations.lastTransactionPostedAt,
        { accountId },
      );
      const fromMs = lastPostedAt
        ? lastPostedAt - RESYNC_OVERLAP_DAYS * DAY_MS
        : Date.now() - clampBackfillDays(args.backfillDays) * DAY_MS;
      const toMs = Date.now();

      const txs = await client.listTransactions(
        a.accountId,
        msToIsoDate(fromMs),
        msToIsoDate(toMs),
      );
      const ids = assignTransactionIds(txs);

      let latestPostedAt = -Infinity;
      let latestRunningBalanceCents: number | undefined;
      const rows = txs.map((tx, i) => {
        const postedAt = derivePostedAtMs(tx);
        const runningBalanceCents =
          typeof tx.runningBalance === "number" ? Math.round(tx.runningBalance * 100) : undefined;
        if (runningBalanceCents !== undefined && postedAt >= latestPostedAt) {
          latestPostedAt = postedAt;
          latestRunningBalanceCents = runningBalanceCents;
        }
        const description = normaliseDescription(tx.description);
        const beneficiaryName = resolveBeneficiaryName(
          tx.transactionType,
          description,
          tx.amount,
          tx.transactionDate ?? tx.postingDate ?? null,
          beneficiaryIndex,
        );
        if (beneficiaryName) beneficiaryMatches++;
        return {
          accountId,
          investecTransactionId: ids[i],
          postedAt,
          amountCents: deriveAmountCents(tx.amount, tx.type),
          currency: (tx.currencyCode ?? a.currency ?? "ZAR").toUpperCase(),
          description,
          merchantName: beneficiaryName ?? deriveMerchantName(description),
          type: tx.type,
          // Sandbox returns null for savings products; the validator wants undefined.
          transactionType: tx.transactionType ?? undefined,
          status: tx.status ?? undefined,
          mcc: tx.mcc ?? undefined,
          rawData: JSON.stringify(tx),
          runningBalanceCents,
        };
      });
      for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
        const batch = await ctx.runMutation(internal.investec.mutations.upsertTransactionBatch, {
          rows: rows.slice(i, i + UPSERT_BATCH_SIZE),
        });
        transactionsInserted += batch.inserted;
        transactionsUpdated += batch.updated;
      }

      // --- 2. Balance: authoritative endpoint, else newest runningBalance ---
      try {
        const balance = await client.getBalance(a.accountId);
        await ctx.runMutation(internal.investec.mutations.updateAccountBalance, {
          accountId,
          currentBalanceCents: Math.round(balance.currentBalance * 100),
          availableBalanceCents: Math.round(balance.availableBalance * 100),
          balanceSource: "balance_endpoint",
          balanceAsOf: Date.now(),
          currency: balance.currency,
        });
        balanceFromEndpoint++;
      } catch (err) {
        warnings.push(`balance endpoint failed for ${a.accountNumber}: ${errorMessage(err)}`);
        if (latestRunningBalanceCents !== undefined) {
          await ctx.runMutation(internal.investec.mutations.updateAccountBalance, {
            accountId,
            currentBalanceCents: latestRunningBalanceCents,
            balanceSource: "running_balance",
            balanceAsOf: Date.now(),
          });
          balanceFromRunningBalance++;
        }
      }

      // --- 3. Pending transactions (snapshot; best-effort) -----------------
      try {
        const pending = await client.listPendingTransactions(a.accountId);
        const result = await ctx.runMutation(internal.investec.mutations.replacePendingTransactions, {
          accountId,
          rows: pending.map((p) => ({
            description: normaliseDescription(p.description),
            amountCents: deriveAmountCents(p.amount, p.type),
            expectedAt: derivePostedAtMs({ transactionDate: p.transactionDate }),
            rawData: JSON.stringify(p),
          })),
        });
        pendingSynced += result.inserted;
      } catch (err) {
        // The sandbox returns 500 for every account except the main one.
        // Leave whatever we had; the rows carry updatedAt for staleness checks.
        warnings.push(`pending endpoint unavailable for ${a.accountNumber}: ${errorMessage(err)}`);
      }

      await ctx.runMutation(internal.recurring.detect.recompute, { accountId });
    }

    await ctx.runMutation(internal.investec.mutations.finishSyncRun, {
      id: runId,
      status: "success",
      accountsSynced,
      transactionsInserted,
      transactionsUpdated,
    });

    if (warnings.length > 0) console.warn("investec_sync_warnings", warnings);
    return {
      accountsSynced,
      transactionsInserted,
      transactionsUpdated,
      pendingSynced,
      balanceFromEndpoint,
      balanceFromRunningBalance,
      beneficiariesLoaded,
      beneficiaryMatches,
      apiHost,
      warnings,
    };
  } catch (err) {
    await ctx.runMutation(internal.investec.mutations.finishSyncRun, {
      id: runId,
      status: "error",
      accountsSynced,
      transactionsInserted,
      transactionsUpdated,
      error: errorMessage(err),
    });
    throw err;
  }
}

export const run = internalAction({
  args: {
    triggeredBy: v.union(v.literal("cron"), v.literal("manual")),
    backfillDays: v.optional(v.number()),
  },
  returns: syncResult,
  handler: async (ctx, args) => syncAllAccounts(ctx, args),
});

/** Public action so the UI's "Sync now" button can trigger a fresh pull. */
export const runNow = action({
  args: {},
  returns: syncResult,
  handler: async (ctx) => syncAllAccounts(ctx, { triggeredBy: "manual" }),
});
