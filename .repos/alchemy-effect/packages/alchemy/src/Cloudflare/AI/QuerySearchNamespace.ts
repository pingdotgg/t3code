import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { QuerySearchClient, SearchError } from "./QuerySearch.ts";
import type { SearchNamespace } from "./SearchNamespace.ts";

/**
 * Bind a {@link SearchNamespace} to a Worker and obtain the Effect-native
 * namespace client whose `.get(name)` selects an instance at runtime. The
 * `ai_search_namespace` binding resolves to a runtime `SearchNamespace`
 * whose `.get(name)` selects an instance within the namespace at runtime.
 *
 * `QuerySearchNamespace` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.AI.QuerySearchNamespace(namespace)`.
 *
 * Provide {@link QuerySearchNamespaceBinding} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying a namespace
 * @example Select an instance at runtime
 * ```typescript
 * const ns = yield* Cloudflare.AI.QuerySearchNamespace(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* ns.get("docs-search").chatCompletions({
 *       messages: [{ role: "user", content: query }],
 *     });
 *     return yield* HttpServerResponse.json(answer);
 *   }),
 * };
 * ```
 */
export interface QuerySearchNamespace extends Binding.Service<
  QuerySearchNamespace,
  "Cloudflare.AI.SearchNamespace",
  (namespace: SearchNamespace) => Effect.Effect<QuerySearchNamespaceClient>
> {}

export const QuerySearchNamespace = Binding.Service<QuerySearchNamespace>(
  "Cloudflare.AI.SearchNamespace",
);

/**
 * Effect-native client for an `ai_search_namespace` binding, wrapping the
 * runtime `SearchNamespace`. `.get(name)` selects an instance within the
 * bound namespace and returns its {@link QuerySearchClient}; `list` / `search`
 * operate across the namespace.
 */
export interface QuerySearchNamespaceClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `SearchNamespace`
   * binding. Use this for operations not surfaced below (`create`, `delete`,
   * multi-instance `chatCompletions`).
   */
  raw: Effect.Effect<runtime.AiSearchNamespace, never, RuntimeContext>;
  /**
   * Select an instance within the bound namespace by name.
   */
  get(instanceName: string): QuerySearchClient;
  /**
   * List the instances within the bound namespace.
   */
  list(
    params?: runtime.AiSearchListInstancesParams,
  ): Effect.Effect<runtime.AiSearchListResponse, SearchError, RuntimeContext>;
  /**
   * Search across multiple instances in the bound namespace (requires
   * `ai_search_options.instance_ids`).
   */
  search(
    params: runtime.AiSearchMultiSearchRequest,
  ): Effect.Effect<
    runtime.AiSearchMultiSearchResponse,
    SearchError,
    RuntimeContext
  >;
}
