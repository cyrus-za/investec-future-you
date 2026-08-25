import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

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

export const upsertTransaction = internalMutation({
  args: {
    accountId: v.id("accounts"),
    investecTransactionId: v.string(),
    postedAt: v.number(),
    amountCents: v.number(),
    currency: v.string(),
    description: v.string(),
    merchantName: v.optional(v.string()),
    type: v.string(),
    mcc: v.optional(v.string()),
    rawData: v.optional(v.string()),
    runningBalanceCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
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
        mcc: args.mcc,
        rawData: args.rawData,
        runningBalanceCents: args.runningBalanceCents,
        updatedAt: Date.now(),
      });
      return "updated" as const;
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
      mcc: args.mcc,
      rawData: args.rawData,
      runningBalanceCents: args.runningBalanceCents,
      updatedAt: Date.now(),
    });
    return "inserted" as const;
  },
});

export const updateAccountBalance = internalMutation({
  args: { accountId: v.id("accounts"), currentBalanceCents: v.number(), balanceAsOf: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      currentBalanceCents: args.currentBalanceCents,
      balanceAsOf: args.balanceAsOf,
    });
  },
});

export const startSyncRun = internalMutation({
  args: { triggeredBy: v.union(v.literal("cron"), v.literal("manual")) },
  handler: async (ctx, args) => {
    return await ctx.db.insert("syncRuns", {
      startedAt: Date.now(),
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
