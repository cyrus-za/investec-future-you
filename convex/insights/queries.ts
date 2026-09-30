import { v } from "convex/values";
import { query } from "../_generated/server";
import { compareInsights } from "./derive";

/**
 * Active (non-dismissed) insights for an account, most severe first.
 * Falls back to the first account when none is given, matching
 * `api.forecast.queries.*`.
 */
export const list = query({
  args: { accountId: v.optional(v.id("accounts")) },
  handler: async (ctx, args) => {
    const account = args.accountId
      ? await ctx.db.get(args.accountId)
      : await ctx.db.query("accounts").first();
    if (!account) return [];
    const rows = await ctx.db
      .query("insights")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .take(100);
    return rows
      .filter((r) => r.dismissedAt === undefined)
      .sort((a, b) => compareInsights(a, b) || a.createdAt - b.createdAt);
  },
});
