import { query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    return accounts
      .map((a) => ({
        _id: a._id,
        name: a.name,
        currency: a.currency,
        currentBalanceCents: a.currentBalanceCents ?? null,
        balanceAsOf: a.balanceAsOf ?? null,
        investecAccountNumber: a.investecAccountNumber,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
