import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { QuerySearch } from "./QuerySearch.ts";
import { makeLocalSearchClient, type SearchAuth } from "./SearchHttpClient.ts";
import type { SearchInstance } from "./SearchInstance.ts";

/**
 * Local implementation of the {@link QuerySearch} binding — queries an AI
 * Search instance over the Cloudflare HTTP API using the **current
 * credentials** instead of a native Worker binding (`QuerySearchBinding`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to run
 * `search` / `chatCompletions` / `info` / `stats` against an instance with the
 * same client you'd use inside a Worker. The instance id and namespace are
 * resolved at apply time through the ambient RuntimeContext, so
 * `QuerySearch(instance)` works even when the instance is created in the same
 * deploy.
 *
 * `raw` (the native `AiSearchInstance` runtime handle) is unavailable outside a
 * deployed Worker and dies if forced.
 *
 * @example Read an instance's status from an Action
 * ```typescript
 * const Probe = Alchemy.Action(
 *   "Probe",
 *   Effect.gen(function* () {
 *     const search = yield* Cloudflare.AI.QuerySearch(instance);
 *     return Effect.fn(function* () {
 *       const info = yield* search.info();
 *       const stats = yield* search.stats();
 *       return { status: info.status, indexed: stats.completed };
 *     });
 *   }).pipe(Effect.provide(Cloudflare.AI.QuerySearchLocal)),
 * );
 * ```
 */
export const QuerySearchLocal = Layer.effect(
  QuerySearch,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so each HTTP op can be run
    // with the current credentials; no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    const auth: SearchAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId,
    };

    return Effect.fn(function* (instance: SearchInstance) {
      // Deferred accessors — resolved against the tracker at apply time.
      const instanceId = yield* instance.instanceId;
      const namespace = yield* instance.namespace;
      return makeLocalSearchClient(
        auth,
        Effect.all({ id: instanceId, name: namespace }),
      );
    });
  }),
);
