import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";

export const MAX_THREAD_MESSAGES = 200;

const roleValidator = v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"));

/** Full history for one thread, oldest first (bounded). */
export const listMessages = query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .take(MAX_THREAD_MESSAGES);
    return rows.map((m) => ({
      _id: m._id,
      role: m.role,
      content: m.content,
      meta: m.meta ?? null,
      createdAt: m.createdAt,
    }));
  },
});

/** Delete every message in a thread (the user's "clear conversation"). */
export const clearThread = mutation({
  args: { threadId: v.string() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    let deleted = 0;
    // Threads are small (bounded by MAX_THREAD_MESSAGES) so a couple of
    // batches is plenty; loop defensively anyway.
    for (let i = 0; i < 10; i++) {
      const batch = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
        .take(100);
      for (const row of batch) {
        await ctx.db.delete(row._id);
        deleted++;
      }
      if (batch.length < 100) break;
    }
    return { deleted };
  },
});

export const append = internalMutation({
  args: {
    threadId: v.string(),
    accountId: v.optional(v.id("accounts")),
    role: roleValidator,
    content: v.string(),
    meta: v.optional(v.any()),
  },
  returns: v.id("chatMessages"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      accountId: args.accountId,
      role: args.role,
      content: args.content,
      meta: args.meta,
      createdAt: Date.now(),
    });
  },
});

/** Last `limit` user/assistant turns, oldest first — the model's memory. */
export const recent = internalQuery({
  args: { threadId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(Math.max(1, Math.min(50, Math.round(args.limit))));
    return rows
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  },
});
