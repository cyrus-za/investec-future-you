import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

/**
 * Deterministic pseudo-random jitter (no external RNG dependency) so the
 * seed produces the same synthetic data every time it's run.
 */
function jitter(seed: number, spreadCents: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const frac = x - Math.floor(x);
  return Math.round((frac - 0.5) * 2 * spreadCents);
}

type SeedTx = {
  key: string; // stable id, independent of when the seed is run
  daysAgo: number;
  amountCents: number; // signed
  description: string;
  merchantName: string;
};

/** Build ~6 months of synthetic transactions ending today. */
function buildSyntheticTransactions(): SeedTx[] {
  const txs: SeedTx[] = [];
  const now = Date.now();
  const monthsBack = 6;

  for (let m = 0; m < monthsBack; m++) {
    const monthAnchor = new Date(now - m * 30 * DAY_MS);
    const year = monthAnchor.getUTCFullYear();
    const month = monthAnchor.getUTCMonth() + 1;
    const daysAgo = (ms: number) => Math.round((now - ms) / DAY_MS);

    // Payday: last business-ish day of month, fixed amount.
    txs.push({
      key: `salary-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 25)),
      amountCents: 3800000 + jitter(m + 1, 0), // R38,000.00, fixed
      description: "SALARY ACME CORP",
      merchantName: "ACME CORP",
    });

    // Rent: fixed, 1st of month.
    txs.push({
      key: `rent-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 1)),
      amountCents: -1250000, // -R12,500.00
      description: "RENT PAYMENT SUNSET APARTMENTS",
      merchantName: "SUNSET APARTMENTS",
    });

    // Insurance: fixed, 2nd of month.
    txs.push({
      key: `insurance-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 2)),
      amountCents: -85000, // -R850.00
      description: "OUTSURANCE PREMIUM",
      merchantName: "OUTSURANCE",
    });

    // Gym: fixed, 3rd of month.
    txs.push({
      key: `gym-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 3)),
      amountCents: -45000, // -R450.00
      description: "VIRGIN ACTIVE DEBIT ORDER",
      merchantName: "VIRGIN ACTIVE",
    });

    // Streaming subscriptions: fixed, small.
    txs.push({
      key: `netflix-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 5)),
      amountCents: -19900,
      description: "NETFLIX.COM",
      merchantName: "NETFLIX",
    });
    txs.push({
      key: `spotify-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 7)),
      amountCents: -9900,
      description: "SPOTIFY",
      merchantName: "SPOTIFY",
    });

    // Electricity: monthly but variable amount (seasonal-ish jitter).
    txs.push({
      key: `electricity-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 10)),
      amountCents: -(180000 + jitter(m + 10, 40000)),
      description: "CITY POWER ELECTRICITY",
      merchantName: "CITY POWER",
    });

    // Groceries: weekly-ish, variable amount, same merchant.
    for (let w = 0; w < 4; w++) {
      const day = 4 + w * 7;
      if (day > 28) continue;
      txs.push({
        key: `groceries-m${m}-w${w}`,
        daysAgo: daysAgo(utcDate(year, month, day)),
        amountCents: -(80000 + jitter(m * 10 + w, 25000)),
        description: "WOOLWORTHS SANDTON ZA",
        merchantName: "WOOLWORTHS",
      });
    }

    // A one-off, non-recurring purchase (should NOT be detected as recurring).
    if (m % 2 === 0) {
      txs.push({
        key: `takealot-m${m}`,
        daysAgo: daysAgo(utcDate(year, month, 18)),
        amountCents: -(120000 + jitter(m + 99, 60000)),
        description: `TAKEALOT.COM ORDER ${1000000 + m}`,
        merchantName: "TAKEALOT.COM",
      });
    }
  }

  return txs.filter((t) => t.daysAgo >= 0);
}

export const seedDemoAccount = mutation({
  args: {},
  returns: v.object({ accountId: v.id("accounts"), transactionsInserted: v.number() }),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_investec_account_id", (q) => q.eq("investecAccountId", "demo-synthetic-account"))
      .first();
    const accountId =
      existing?._id ??
      (await ctx.db.insert("accounts", {
        investecAccountId: "demo-synthetic-account",
        investecAccountNumber: "0000000000",
        name: "Demo Everyday Account (synthetic)",
        currency: "ZAR",
        updatedAt: Date.now(),
      }));

    const now = Date.now();
    const STARTING_BALANCE_CENTS = 1500000; // R15,000.00 opening balance 6 months ago
    const chronological = buildSyntheticTransactions().sort((a, b) => b.daysAgo - a.daysAgo);

    let inserted = 0;
    let runningBalanceCents = STARTING_BALANCE_CENTS;
    let latestRunningBalanceCents = STARTING_BALANCE_CENTS;
    for (const tx of chronological) {
      const postedAt = now - tx.daysAgo * DAY_MS;
      runningBalanceCents += tx.amountCents;
      latestRunningBalanceCents = runningBalanceCents;
      const investecTransactionId = `demo-${tx.key}`;
      const existingTx = await ctx.db
        .query("transactions")
        .withIndex("by_investec_transaction_id", (q) =>
          q.eq("investecTransactionId", investecTransactionId),
        )
        .first();
      if (existingTx) {
        await ctx.db.patch(existingTx._id, {
          postedAt,
          amountCents: tx.amountCents,
          runningBalanceCents,
          updatedAt: Date.now(),
        });
        continue;
      }
      await ctx.db.insert("transactions", {
        accountId,
        investecTransactionId,
        postedAt,
        amountCents: tx.amountCents,
        currency: "ZAR",
        description: tx.description,
        merchantName: tx.merchantName,
        type: tx.amountCents < 0 ? "DEBIT" : "CREDIT",
        runningBalanceCents,
        updatedAt: Date.now(),
      });
      inserted++;
    }

    await ctx.db.patch(accountId, {
      currentBalanceCents: latestRunningBalanceCents,
      balanceAsOf: now,
    });

    await ctx.runMutation(internal.recurring.detect.recompute, { accountId });

    return { accountId, transactionsInserted: inserted };
  },
});
