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
  /** Mirrors Investec's transactionType so detection sees the same signal as real data. */
  transactionType: "DebitOrders" | "CardPurchases" | "Deposits";
};

/** How much the most recent electricity bill is inflated (→ amount_spike insight). */
const ELECTRICITY_SPIKE_FACTOR = 1.45;

/** Build ~6 months of synthetic transactions ending today. */
export function buildSyntheticTransactions(): SeedTx[] {
  const txs: SeedTx[] = [];
  const now = Date.now();
  const monthsBack = 6;
  // Step real calendar months. A 30-day offset double-books a month when
  // today is the 30th or 31st (two "25ths" land in the same month).
  const today = new Date(now);

  for (let m = 0; m < monthsBack; m++) {
    const monthAnchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1));
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
      transactionType: "Deposits",
    });

    // Rent: fixed, 1st of month.
    txs.push({
      key: `rent-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 1)),
      amountCents: -1250000, // -R12,500.00
      description: "RENT PAYMENT SUNSET APARTMENTS",
      merchantName: "SUNSET APARTMENTS",
      transactionType: "DebitOrders",
    });

    // Insurance: fixed, 2nd of month.
    txs.push({
      key: `insurance-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 2)),
      amountCents: -85000, // -R850.00
      description: "OUTSURANCE PREMIUM",
      merchantName: "OUTSURANCE",
      transactionType: "DebitOrders",
    });

    // Gym: fixed, 3rd of month.
    txs.push({
      key: `gym-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 3)),
      amountCents: -45000, // -R450.00
      description: "VIRGIN ACTIVE DEBIT ORDER",
      merchantName: "VIRGIN ACTIVE",
      transactionType: "DebitOrders",
    });

    // Streaming subscriptions: fixed, small.
    txs.push({
      key: `netflix-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 5)),
      amountCents: -19900,
      description: "NETFLIX.COM",
      merchantName: "NETFLIX",
      transactionType: "DebitOrders",
    });
    txs.push({
      key: `showmax-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 6)),
      amountCents: -9900,
      description: "SHOWMAX",
      merchantName: "SHOWMAX",
      transactionType: "DebitOrders",
    });
    txs.push({
      key: `spotify-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 7)),
      amountCents: -9900,
      description: "SPOTIFY",
      merchantName: "SPOTIFY",
      transactionType: "DebitOrders",
    });

    // DSTV: ran for the three oldest months, then stopped (→ missed_payment).
    if (m >= 3) {
      txs.push({
        key: `dstv-m${m}`,
        daysAgo: daysAgo(utcDate(year, month, 15)),
        amountCents: -89900,
        description: "DSTV SUBSCRIPTION",
        merchantName: "DSTV",
        transactionType: "DebitOrders",
      });
    }

    // Electricity: monthly but variable amount (seasonal-ish jitter).
    txs.push({
      key: `electricity-m${m}`,
      daysAgo: daysAgo(utcDate(year, month, 10)),
      amountCents: -(180000 + jitter(m + 10, 40000)),
      description: "CITY POWER ELECTRICITY",
      merchantName: "CITY POWER",
      transactionType: "DebitOrders",
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
        transactionType: "CardPurchases",
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
        transactionType: "CardPurchases",
      });
    }
  }

  const past = txs.filter((t) => t.daysAgo >= 0);

  // Inflate the most recent electricity bill relative to the median of the
  // earlier ones, so the demo reliably shows an "amount spike" insight.
  const electricity = past
    .filter((t) => t.key.startsWith("electricity-"))
    .sort((a, b) => a.daysAgo - b.daysAgo);
  if (electricity.length >= 3) {
    const earlier = electricity.slice(1).map((t) => Math.abs(t.amountCents)).sort((a, b) => a - b);
    const mid = Math.floor(earlier.length / 2);
    const baseline = earlier.length % 2 === 0 ? (earlier[mid - 1] + earlier[mid]) / 2 : earlier[mid];
    electricity[0].amountCents = -Math.round(baseline * ELECTRICITY_SPIKE_FACTOR);
  }

  return past;
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
          description: tx.description,
          merchantName: tx.merchantName,
          transactionType: tx.transactionType,
          status: "POSTED",
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
        transactionType: tx.transactionType,
        status: "POSTED",
        runningBalanceCents,
        updatedAt: Date.now(),
      });
      inserted++;
    }

    await ctx.db.patch(accountId, {
      currentBalanceCents: latestRunningBalanceCents,
      balanceAsOf: now,
      balanceSource: "synthetic",
      updatedAt: now,
    });

    await ctx.runMutation(internal.recurring.detect.recompute, { accountId });
    await ctx.runMutation(internal.categorisation.recomputeForAccount, { accountId });

    return { accountId, transactionsInserted: inserted };
  },
});
