import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { DAY_MS, msToIsoDate } from "../lib/dates";
import { InvestecClient, type TokenCache } from "./client";
import {
  deriveAmountCents,
  deriveMerchantName,
  derivePostedAtMs,
  deriveTransactionId,
} from "./mapping";

const DEFAULT_BACKFILL_DAYS = 180;
const RESYNC_OVERLAP_DAYS = 3;

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
});

type SyncArgs = { triggeredBy: "cron" | "manual"; backfillDays?: number };
type SyncResult = {
  accountsSynced: number;
  transactionsInserted: number;
  transactionsUpdated: number;
};

/** Shared implementation called directly by both `run` and `runNow` below —
 * kept as a plain function (not a cross-call via ctx.runAction) so the two
 * exports in this file don't create a circular type reference through the
 * generated `internal` API object. */
async function syncAllAccounts(ctx: ActionCtx, args: SyncArgs): Promise<SyncResult> {
    const runId = await ctx.runMutation(internal.investec.mutations.startSyncRun, {
      triggeredBy: args.triggeredBy,
    });

    const tokenCache: TokenCache = {
      get: () => ctx.runQuery(internal.investec.token.get, {}),
      set: (token) => ctx.runMutation(internal.investec.token.set, token),
      clear: () => ctx.runMutation(internal.investec.token.clear, {}),
    };
    const client = new InvestecClient(
      {
        baseUrl: requireEnv("INVESTEC_BASE_URL"),
        clientId: requireEnv("INVESTEC_CLIENT_ID"),
        clientSecret: requireEnv("INVESTEC_CLIENT_SECRET"),
        apiKey: requireEnv("INVESTEC_API_KEY"),
      },
      tokenCache,
    );

    let accountsSynced = 0;
    let transactionsInserted = 0;
    let transactionsUpdated = 0;
    try {
      const accounts = await client.listAccounts();
      for (const a of accounts) {
        const name =
          a.referenceName ?? a.productName ?? a.accountName ?? `Account ${a.accountNumber}`;
        const accountId = await ctx.runMutation(internal.investec.mutations.upsertAccount, {
          investecAccountId: a.accountId,
          investecAccountNumber: a.accountNumber,
          name,
          currency: (a.currency ?? "ZAR").toUpperCase(),
        });
        accountsSynced++;

        const lastPostedAt = await ctx.runQuery(
          internal.investec.mutations.lastTransactionPostedAt,
          { accountId },
        );
        const fromMs = lastPostedAt
          ? lastPostedAt - RESYNC_OVERLAP_DAYS * DAY_MS
          : Date.now() - (args.backfillDays ?? DEFAULT_BACKFILL_DAYS) * DAY_MS;
        const toMs = Date.now();

        const txs = await client.listTransactions(
          a.accountId,
          msToIsoDate(fromMs),
          msToIsoDate(toMs),
        );

        let latestPostedAt = -Infinity;
        let latestRunningBalanceCents: number | undefined;
        for (const tx of txs) {
          const postedAt = derivePostedAtMs(tx);
          const runningBalanceCents =
            typeof tx.runningBalance === "number"
              ? Math.round(tx.runningBalance * 100)
              : undefined;
          const result = await ctx.runMutation(internal.investec.mutations.upsertTransaction, {
            accountId,
            investecTransactionId: deriveTransactionId(tx),
            postedAt,
            amountCents: deriveAmountCents(tx.amount, tx.type),
            currency: (tx.currencyCode ?? a.currency ?? "ZAR").toUpperCase(),
            description: tx.description,
            merchantName: deriveMerchantName(tx.description),
            type: tx.type,
            mcc: tx.mcc,
            rawData: JSON.stringify(tx),
            runningBalanceCents,
          });
          if (result === "inserted") transactionsInserted++;
          else transactionsUpdated++;
          if (runningBalanceCents !== undefined && postedAt >= latestPostedAt) {
            latestPostedAt = postedAt;
            latestRunningBalanceCents = runningBalanceCents;
          }
        }

        if (latestRunningBalanceCents !== undefined) {
          await ctx.runMutation(internal.investec.mutations.updateAccountBalance, {
            accountId,
            currentBalanceCents: latestRunningBalanceCents,
            balanceAsOf: Date.now(),
          });
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.investec.mutations.finishSyncRun, {
        id: runId,
        status: "error",
        accountsSynced,
        transactionsInserted,
        transactionsUpdated,
        error: message,
      });
      throw err;
    }

    return { accountsSynced, transactionsInserted, transactionsUpdated };
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
