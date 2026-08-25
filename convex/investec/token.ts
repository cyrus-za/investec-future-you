import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const get = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("investecToken").first();
    if (!row) return null;
    return { accessToken: row.accessToken, expiresAt: row.expiresAt };
  },
});

export const set = internalMutation({
  args: { accessToken: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("investecToken").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
      });
    } else {
      await ctx.db.insert("investecToken", {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
      });
    }
  },
});

export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("investecToken").first();
    if (existing) await ctx.db.delete(existing._id);
  },
});
