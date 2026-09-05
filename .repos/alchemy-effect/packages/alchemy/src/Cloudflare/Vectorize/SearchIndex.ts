import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./VectorizeIndex.ts";

/**
 * Bind a {@link Index} to a Worker and obtain the Effect-native Vectorize
 * client (`describe`, `query`, `upsert`, …).
 *
 * `SearchIndex` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Vectorize.SearchIndex(index)`.
 *
 * @example Querying an index inside a Worker
 * ```typescript
 * const vec = yield* Cloudflare.Vectorize.SearchIndex(MyIndex);
 * const matches = yield* vec.query([0.1, 0.2, 0.3], { topK: 5 });
 * ```
 *
 * @binding
 * @product Vectorize
 * @category AI
 */
export interface SearchIndex extends Binding.Service<
  SearchIndex,
  "Cloudflare.Vectorize.SearchIndex",
  (index: Index) => Effect.Effect<SearchIndexClient>
> {}

export const SearchIndex = Binding.Service<SearchIndex>(
  "Cloudflare.Vectorize.SearchIndex",
);

export interface SearchIndexClient {
  /**
   * An Effect that resolves to the raw underlying Cloudflare Vectorize
   * binding. Use this for direct access not covered by the helpers below.
   */
  raw: Effect.Effect<runtime.Vectorize>;
  /** Get information about the bound index (dimensions, vector count). */
  describe: () => Effect.Effect<runtime.VectorizeIndexInfo>;
  /** Find the nearest neighbors of `vector`. */
  query: (
    vector: runtime.VectorFloatArray | number[],
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Find the nearest neighbors of an existing vector by its id. */
  queryById: (
    vectorId: string,
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Insert vectors. Throws if any provided id already exists. */
  insert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Upsert vectors, replacing any existing vectors with matching ids. */
  upsert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Delete vectors by id. */
  deleteByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Fetch vectors by id. */
  getByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeVector[]>;
}
