import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SearchInstance } from "./SearchInstance.ts";

/**
 * Bind a {@link SearchInstance} to a Worker and obtain the Effect-native
 * AI Search client (`search`, `chatCompletions`, `info`, `stats`). The
 * single-instance `ai_search` binding resolves directly to a runtime
 * `SearchInstance`.
 *
 * `QuerySearch` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable — `yield* Cloudflare.AI.QuerySearch(instance)`.
 *
 * Provide {@link QuerySearchBinding} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying AI Search
 * @example Retrieve and generate from a Worker
 * Bind the instance during the Worker's init phase, then use `search`
 * (retrieval only) or `chatCompletions` (retrieval + generation) from request
 * handlers.
 * ```typescript
 * const search = yield* Cloudflare.AI.QuerySearch(instance);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* search.chatCompletions({
 *       messages: [{ role: "user", content: "How do I deploy?" }],
 *     });
 *     return yield* HttpServerResponse.json(answer);
 *   }),
 * };
 * ```
 */
export interface QuerySearch extends Binding.Service<
  QuerySearch,
  "Cloudflare.AI.QuerySearch",
  (instance: SearchInstance) => Effect.Effect<QuerySearchClient>
> {}

export const QuerySearch = Binding.Service<QuerySearch>(
  "Cloudflare.AI.QuerySearch",
);

/**
 * Error raised by AI Search runtime binding operations.
 */
export class SearchError extends Data.TaggedError("AiSearchError")<{
  /**
   * Human-readable runtime error message.
   */
  message: string;
  /**
   * Original error thrown by the Cloudflare.AI. Search runtime binding.
   */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare.AI. Search Worker binding.
 *
 * Wraps the standalone `SearchInstance` runtime binding (the binding the
 * `ai_search` type resolves to — the deprecated `AutoRAG` shape is gone) so
 * each operation returns an Effect tagged with {@link SearchError}. Obtain
 * one from `Cloudflare.AI.QuerySearch(instance)` (or a namespace client's
 * `.get(instanceName)`) during the Worker's init phase.
 */
export interface QuerySearchClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `SearchInstance`
   * binding. Use this for operations not surfaced below (`items`, `jobs`,
   * `update`, or streaming `chatCompletions`).
   */
  raw: Effect.Effect<runtime.AiSearchInstance, never, RuntimeContext>;
  /**
   * Retrieve the chunks most relevant to a query without generation.
   */
  search(
    params: runtime.AiSearchSearchRequest,
  ): Effect.Effect<runtime.AiSearchSearchResponse, SearchError, RuntimeContext>;
  /**
   * Run retrieval-augmented generation: retrieve relevant chunks and answer
   * with the configured model (non-streaming).
   */
  chatCompletions(
    params: runtime.AiSearchChatCompletionsRequest,
  ): Effect.Effect<
    runtime.AiSearchChatCompletionsResponse,
    SearchError,
    RuntimeContext
  >;
  /**
   * Metadata about this instance (id, models, source, status, …).
   */
  info(): Effect.Effect<
    runtime.AiSearchInstanceInfo,
    SearchError,
    RuntimeContext
  >;
  /**
   * Indexing statistics (item counts per status, last activity, engine).
   */
  stats(): Effect.Effect<
    runtime.AiSearchStatsResponse,
    SearchError,
    RuntimeContext
  >;
}

export const tryAiSearch = <A>(
  fn: () => Promise<A>,
): Effect.Effect<A, SearchError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new SearchError({
        message:
          cause instanceof Error
            ? cause.message
            : "Unknown AI Search runtime error",
        cause,
      }),
  });

/**
 * Build a {@link QuerySearchClient} from an Effect that lazily resolves the raw
 * `SearchInstance` runtime binding.
 */
export const makeClient = (
  rawEff: Effect.Effect<runtime.AiSearchInstance>,
): QuerySearchClient => {
  const use = <A>(fn: (raw: runtime.AiSearchInstance) => Promise<A>) =>
    Effect.flatMap(rawEff, (raw) => tryAiSearch(() => fn(raw)));
  return {
    raw: rawEff,
    search: (params) => use((raw) => raw.search(params)),
    chatCompletions: (params) => use((raw) => raw.chatCompletions(params)),
    info: () => use((raw) => raw.info()),
    stats: () => use((raw) => raw.stats()),
  } satisfies QuerySearchClient;
};
