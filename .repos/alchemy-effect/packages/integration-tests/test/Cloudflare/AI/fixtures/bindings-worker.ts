/// <reference types="@cloudflare/workers-types" />

/**
 * Plain (non-Effect) Worker handler exercising the two AI Search binding
 * shapes wired via `env`:
 * - `SEARCH` is a single-instance `ai_search` binding (an `AiSearchInstance`).
 * - `NS` is an `ai_search_namespace` binding (`.get(name)` selects an
 *   instance within the namespace).
 *
 * The `/bindings` route only reports that the bindings are present and
 * shaped correctly at runtime — it does not run a query (that needs indexed
 * data). Proving the bindings are injected is enough to validate that the
 * Worker deploy accepted them.
 */
interface Env {
  SEARCH: AiSearchInstance;
  NS: AiSearchNamespace;
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/bindings") {
      return Response.json({
        search: typeof env.SEARCH,
        searchChatCompletions: typeof env.SEARCH?.chatCompletions,
        searchSearch: typeof env.SEARCH?.search,
        ns: typeof env.NS,
        nsGet: typeof env.NS?.get,
      });
    }
    return new Response("ok");
  },
};
