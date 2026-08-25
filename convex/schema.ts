import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per linked Investec account (sandbox: usually just one).
  accounts: defineTable({
    investecAccountId: v.string(),
    investecAccountNumber: v.string(),
    name: v.string(),
    currency: v.string(),
    // Latest known available balance, derived from the most recent
    // transaction's runningBalance (Investec doesn't require a separate
    // balance call since transactions already carry it).
    currentBalanceCents: v.optional(v.number()),
    balanceAsOf: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_investec_account_id", ["investecAccountId"]),

  // Normalised, deduplicated Investec transactions.
  transactions: defineTable({
    accountId: v.id("accounts"),
    investecTransactionId: v.string(),
    postedAt: v.number(), // unix ms, derived from transactionDate/postingDate
    amountCents: v.number(), // signed: negative = debit, positive = credit
    currency: v.string(),
    description: v.string(),
    merchantName: v.optional(v.string()),
    type: v.string(), // "DEBIT" | "CREDIT" (raw Investec value)
    mcc: v.optional(v.string()),
    rawData: v.optional(v.string()),
    runningBalanceCents: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_investec_transaction_id", ["investecTransactionId"])
    .index("by_account_and_postedAt", ["accountId", "postedAt"]),

  // Detected recurring payment / income series, recomputed after each sync.
  recurringSeries: defineTable({
    accountId: v.id("accounts"),
    merchantKey: v.string(), // normalised grouping key (merchantBaseName)
    label: v.string(), // human-readable merchant/description sample
    direction: v.union(v.literal("debit"), v.literal("credit")),
    cadence: v.union(
      v.literal("weekly"),
      v.literal("biweekly"),
      v.literal("monthly"),
      v.literal("irregular"),
    ),
    typicalAmountCents: v.number(), // positive magnitude
    amountVariance: v.number(), // 0 = perfectly fixed amount, higher = more variable
    intervalDays: v.number(), // median days between occurrences
    occurrenceCount: v.number(),
    lastOccurrenceAt: v.number(),
    predictedNextAt: v.number(),
    confidence: v.number(), // 0..1
    isPayday: v.boolean(),
    transactionIds: v.array(v.id("transactions")),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  // Single-row cache of the Investec OAuth2 client_credentials token.
  investecToken: defineTable({
    accessToken: v.string(),
    expiresAt: v.number(), // unix ms
  }),

  // Audit trail of sync attempts (mirrors household-budget's syncRun table).
  syncRuns: defineTable({
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("error"),
    ),
    triggeredBy: v.union(v.literal("cron"), v.literal("manual")),
    accountsSynced: v.number(),
    transactionsInserted: v.number(),
    transactionsUpdated: v.number(),
    error: v.optional(v.string()),
  }),
});
