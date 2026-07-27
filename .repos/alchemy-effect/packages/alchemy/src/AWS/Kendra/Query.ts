import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `Query` request with `IndexId` injected from the bound index.
 */
export interface QueryRequest extends Omit<kendra.QueryRequest, "IndexId"> {}

/**
 * Runtime binding for the `Query` operation (IAM action
 * `kendra:Query`), scoped to one {@link Index}.
 *
 * Searches the index with a natural-language query — returns ranked
 * answers, FAQ matches, and document results, optionally filtered on
 * document attributes and the querying user's context.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.QueryHttp)`.
 *
 * @binding
 * @section Querying an Index
 * @example Search an Index
 * ```typescript
 * const query = yield* AWS.Kendra.Query(index);
 *
 * const results = yield* query({ QueryText: "how do I configure SSO?" });
 * for (const item of results.ResultItems ?? []) {
 *   console.log(item.Type, item.DocumentTitle?.Text);
 * }
 * ```
 */
export interface Query extends Binding.Service<
  Query,
  "AWS.Kendra.Query",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request?: QueryRequest,
    ) => Effect.Effect<kendra.QueryResult, kendra.QueryError>
  >
> {}
export const Query = Binding.Service<Query>("AWS.Kendra.Query");
