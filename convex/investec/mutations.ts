import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";

/** A run still marked `running` after this long is assumed to have died
 * (action evicted, upstream hang before timeouts existed, ...). */
export const STALE_SYNC_RUN_MS = 30 * 60 * 1000;

export const balanceSourceValidator = v.union(
  v.literal("balance_endpoint"),
  v.literal("running_balance"),
  v.literal("synthetic"),
);

export const upsertAccount = internalMutation({
  args: {
    investecAccountId: v.string(),
    investecAccountNumber: v.string(),
    name: v.string(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_investec_account_id", (q) =>
        q.eq("investecAccountId", args.investecAccountId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        investecAccountNumber: args.investecAccountNumber,
        name: args.name,
        currency: args.currency,
        updatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("accounts", {
      investecAccountId: args.investecAccountId,
      investecAccountNumber: args.investecAccountNumber,
      name: args.name,
      currency: args.currency,
      updatedAt: Date.now(),
    });
  },
});

export const lastTransactionPostedAt = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("transactions")
      .withIndex("by_account_and_postedAt", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .first();
    return last?.postedAt ?? null;
  },
});

const transactionRowValidator = v.object({
  accountId: v.id("accounts"),
  investecTransactionId: v.string(),
  postedAt: v.number(),
  amountCents: v.number(),
  currency: v.string(),
  description: v.string(),
  merchantName: v.optional(v.string()),
  type: v.string(),
  transactionType: v.optional(v.string()),
  status: v.optional(v.string()),
  mcc: v.optional(v.string()),
  rawData: v.optional(v.string()),
  runningBalanceCents: v.optional(v.number()),
});

async function upsertOne(
  ctx: MutationCtx,
  args: Infer<typeof transactionRowValidator>,
): Promise<"inserted" | "updated"> {
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_investec_transaction_id", (q) =>
      q.eq("investecTransactionId", args.investecTransactionId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      accountId: args.accountId,
      postedAt: args.postedAt,
      amountCents: args.amountCents,
      currency: args.currency,
      description: args.description,
      merchantName: args.merchantName,
      type: args.type,
      // Keep previously-known values if a later payload omits them.
      transactionType: args.transactionType ?? existing.transactionType,
      status: args.status ?? existing.status,
      mcc: args.mcc ?? existing.mcc,
      rawData: args.rawData,
      runningBalanceCents: args.runningBalanceCents,
      updatedAt: Date.now(),
    });
    return "updated";
  }
  await ctx.db.insert("transactions", {
    accountId: args.accountId,
    investecTransactionId: args.investecTransactionId,
    postedAt: args.postedAt,
    amountCents: args.amountCents,
    currency: args.currency,
    description: args.description,
    merchantName: args.merchantName,
    type: args.type,
    transactionType: args.transactionType,
    status: args.status,
    mcc: args.mcc,
    rawData: args.rawData,
    runningBalanceCents: args.runningBalanceCents,
    updatedAt: Date.now(),
  });
  return "inserted";
}

export const upsertTransaction = internalMutation({
  args: transactionRowValidator.fields,
  handler: async (ctx, args) => upsertOne(ctx, args),
});

/** Same as upsertTransaction, for a chunk of rows in one transaction (the
 * sync sends ~100 at a time instead of one action->mutation hop per row). */
export const upsertTransactionBatch = internalMutation({
  args: { rows: v.array(transactionRowValidator) },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    for (const row of args.rows) {
      if ((await upsertOne(ctx, row)) === "inserted") inserted++;
      else updated++;
    }
    return { inserted, updated };
  },
});

/**
 * Record where the account's balance came from.
 * - `balance_endpoint`: GET /accounts/:id/balance succeeded; both current and
 *   available balances are authoritative.
 * - `running_balance`: fallback to the newest transaction's runningBalance;
 *   availableBalanceCents is cleared so nobody reads a stale value.
 */
export const updateAccountBalance = internalMutation({
  args: {
    accountId: v.id("accounts"),
    currentBalanceCents: v.number(),
    balanceAsOf: v.number(),
    availableBalanceCents: v.optional(v.number()),
    balanceSource: v.optional(balanceSourceValidator),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      currentBalanceCents: args.currentBalanceCents,
      balanceAsOf: args.balanceAsOf,
      availableBalanceCents:
        args.balanceSource === "balance_endpoint" ? args.availableBalanceCents : undefined,
      ...(args.balanceSource ? { balanceSource: args.balanceSource } : {}),
      ...(args.currency ? { currency: args.currency } : {}),
      updatedAt: Date.now(),
    });
  },
});

const pendingRowValidator = v.object({
  description: v.string(),
  amountCents: v.number(),
  expectedAt: v.number(),
  rawData: v.optional(v.string()),
});

/** Replace (clear-then-insert) the account's pending transactions. Pending
 * rows are a snapshot, not a ledger: once a hold posts it disappears from the
 * endpoint and would otherwise double-count against the posted row. */
export const replacePendingTransactions = internalMutation({
  args: { accountId: v.id("accounts"), rows: v.array(pendingRowValidator) },
  returns: v.object({ removed: v.number(), inserted: v.number() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pendingTransactions")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const row of args.rows) {
      await ctx.db.insert("pendingTransactions", { accountId: args.accountId, ...row, updatedAt: now });
    }
    return { removed: existing.length, inserted: args.rows.length };
  },
});

/**
 * Open a syncRuns row. Refuses to start while another run is genuinely in
 * progress (so cron + "Sync now" can't race), but first marks runs that have
 * been "running" for more than STALE_SYNC_RUN_MS as errored so a crashed
 * action can never block syncing forever.
 */
export const startSyncRun = internalMutation({
  args: { triggeredBy: v.union(v.literal("cron"), v.literal("manual")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const recent = await ctx.db.query("syncRuns").order("desc").take(10);
    for (const run of recent) {
      if (run.status !== "running") continue;
      if (now - run.startedAt > STALE_SYNC_RUN_MS) {
        await ctx.db.patch(run._id, {
          status: "error",
          finishedAt: now,
          error: "stale: run did not finish",
        });
      } else {
        throw new Error(
          `A sync started ${Math.round((now - run.startedAt) / 1000)}s ago is still running; try again shortly.`,
        );
      }
    }
    return await ctx.db.insert("syncRuns", {
      startedAt: now,
      status: "running",
      triggeredBy: args.triggeredBy,
      accountsSynced: 0,
      transactionsInserted: 0,
      transactionsUpdated: 0,
    });
  },
});

export const finishSyncRun = internalMutation({
  args: {
    id: v.id("syncRuns"),
    status: v.union(v.literal("success"), v.literal("error")),
    accountsSynced: v.number(),
    transactionsInserted: v.number(),
    transactionsUpdated: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      finishedAt: Date.now(),
      status: args.status,
      accountsSynced: args.accountsSynced,
      transactionsInserted: args.transactionsInserted,
      transactionsUpdated: args.transactionsUpdated,
      error: args.error,
    });
  },
});

export const listAccounts = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("accounts").collect(),
});

export const listRecentSyncRuns = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db.query("syncRuns").order("desc").take(10),
});
