import { convexTest } from "convex-test";
import schema from "./schema";

/**
 * Glob of every Convex function module, required by convex-test so it can
 * resolve `api.*` / `internal.*` references in the in-memory backend.
 * Excludes test files themselves.
 */
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.ts"]);

export function createTestBackend() {
  return convexTest(schema, modules);
}
