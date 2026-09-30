import { v } from "convex/values";
import { action } from "../_generated/server";
import { OPENAI_MODEL, readApiKey } from "./openai";

/**
 * Is the AI coach usable on this deployment? Called once by the UI on mount
 * so it can render a friendly "not configured" note instead of failing on
 * the first message. Never returns the key itself.
 */
export const isEnabled = action({
  args: {},
  returns: v.object({ enabled: v.boolean(), model: v.string(), reason: v.union(v.string(), v.null()) }),
  handler: async () => {
    const enabled = readApiKey() !== null;
    return {
      enabled,
      model: OPENAI_MODEL,
      reason: enabled ? null : "OPENAI_API_KEY is not set on the Convex deployment.",
    };
  },
});
