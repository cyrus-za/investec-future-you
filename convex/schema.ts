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
    // Authoritative available balance from GET /za/pb/v1/accounts/:id/balance
    // (set by the sync when the endpoint is available). Prefer this over
    // currentBalanceCents when present.
    availableBalanceCents: v.optional(v.number()),
    balanceSource: v.optional(
      v.union(v.literal("balance_endpoint"), v.literal("running_balance"), v.literal("synthetic")),
    ),
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
    // Investec transactionType, e.g. "DebitOrders", "CardPurchases",
    // "OnlineBankingPayments", "FasterPay", "Deposits", "FeesAndInterest",
    // "ATMWithdrawals", "VASTransactions". A strong recurring-payment signal.
    transactionType: v.optional(v.string()),
    status: v.optional(v.string()), // Investec status, e.g. "POSTED"
    // Spending category assigned by convex/categorisation (heuristic, explainable).
    category: v.optional(v.string()),
    mcc: v.optional(v.string()),
    rawData: v.optional(v.string()),
    runningBalanceCents: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_investec_transaction_id", ["investecTransactionId"])
    .index("by_account_and_postedAt", ["accountId", "postedAt"]),

  // Pending (not yet posted) transactions from
  // GET /za/pb/v1/accounts/:id/pending-transactions. These are near-certain
  // upcoming debits and are folded into the forecast with confidence 1.
  pendingTransactions: defineTable({
    accountId: v.id("accounts"),
    description: v.string(),
    amountCents: v.number(), // signed
    expectedAt: v.number(), // unix ms
    rawData: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

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
    // Heuristic category: "subscription" | "utility" | "insurance" | "loan" |
    // "rent" | "income" | "groceries" | "fees" | "other" (free-form string).
    category: v.optional(v.string()),
    // Dominant Investec transactionType across the series' occurrences.
    transactionType: v.optional(v.string()),
    lastAmountCents: v.optional(v.number()), // magnitude of most recent occurrence
    // Anomaly flags computed at detection time (see convex/insights).
    anomalyKind: v.optional(
      v.union(v.literal("amount_spike"), v.literal("amount_drop"), v.literal("missed_payment")),
    ),
    anomalyDetail: v.optional(v.string()),
    transactionIds: v.array(v.id("transactions")),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  // Proactive insights / risk alerts surfaced to the user (recomputed after
  // each detection pass). Examples: "Netflix charged 40% more than usual",
  // "Balance projected to go negative on 14 Sept", "Insurance debit order
  // expected on the 2nd hasn't arrived".
  insights: defineTable({
    accountId: v.id("accounts"),
    kind: v.string(), // e.g. "cashflow_risk" | "amount_spike" | "missed_payment" | "subscription_creep" | "tip"
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
    title: v.string(),
    detail: v.string(),
    relatedMerchantKey: v.optional(v.string()),
    createdAt: v.number(),
    dismissedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // AI coach chat history ("Chat with Future You"). One thread per browser
  // session; the assistant is grounded in the deterministic forecast engine.
  chatMessages: defineTable({
    threadId: v.string(),
    accountId: v.optional(v.id("accounts")),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")),
    content: v.string(),
    meta: v.optional(v.any()), // tool calls / tool results / model info
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

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
