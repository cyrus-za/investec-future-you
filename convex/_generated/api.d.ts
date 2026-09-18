/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as crons from "../crons.js";
import type * as forecast_engine from "../forecast/engine.js";
import type * as forecast_queries from "../forecast/queries.js";
import type * as insights_derive from "../insights/derive.js";
import type * as insights_mutations from "../insights/mutations.js";
import type * as insights_queries from "../insights/queries.js";
import type * as investec_client from "../investec/client.js";
import type * as investec_mapping from "../investec/mapping.js";
import type * as investec_mutations from "../investec/mutations.js";
import type * as investec_sync from "../investec/sync.js";
import type * as investec_token from "../investec/token.js";
import type * as lib_dates from "../lib/dates.js";
import type * as recurring_categories from "../recurring/categories.js";
import type * as recurring_detect from "../recurring/detect.js";
import type * as recurring_format from "../recurring/format.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  crons: typeof crons;
  "forecast/engine": typeof forecast_engine;
  "forecast/queries": typeof forecast_queries;
  "insights/derive": typeof insights_derive;
  "insights/mutations": typeof insights_mutations;
  "insights/queries": typeof insights_queries;
  "investec/client": typeof investec_client;
  "investec/mapping": typeof investec_mapping;
  "investec/mutations": typeof investec_mutations;
  "investec/sync": typeof investec_sync;
  "investec/token": typeof investec_token;
  "lib/dates": typeof lib_dates;
  "recurring/categories": typeof recurring_categories;
  "recurring/detect": typeof recurring_detect;
  "recurring/format": typeof recurring_format;
  seed: typeof seed;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
