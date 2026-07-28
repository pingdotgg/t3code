import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { SearchIndex } from "./SearchIndex.ts";
import {
  type SearchIndexAuth,
  makeHttpSearchIndexClient,
} from "./SearchIndexHttpClient.ts";
import type { Index } from "./VectorizeIndex.ts";

/**
 * Local implementation of the {@link SearchIndex} binding — talks to a
 * Vectorize index over the Cloudflare HTTP API using the **current
 * credentials** instead of a native Worker binding (`SearchIndexBinding`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can
 * insert, upsert, query, and fetch vectors with the same client you'd use
 * inside a Worker — no Worker host, no `host.bind`, no minted token:
 *
 * @example Seeding an index from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const vec = yield* Cloudflare.Vectorize.SearchIndex(index);
 *     return Effect.fn(function* () {
 *       yield* vec.upsert([
 *         { id: "1", values: [0.1, 0.2, 0.3, 0.4] },
 *         { id: "2", values: [0.9, 0.8, 0.7, 0.6] },
 *       ]);
 *       const matches = yield* vec.query([0.1, 0.2, 0.3, 0.4], { topK: 1 });
 *       return matches;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Vectorize.SearchIndexLocal)),
 * );
 * ```
 *
 * The index name is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `SearchIndex(index)` works even though the
 * index is created in the same deploy.
 *
 * `raw` and `queryById` have no Cloudflare HTTP equivalent and `Effect.die` —
 * see {@link makeHttpSearchIndexClient}.
 */
export const SearchIndexLocal = Layer.effect(
  SearchIndex,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the HTTP ops run with the
    // current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: SearchIndexAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId,
    };

    return Effect.fn(function* (index: Index) {
      // Deferred accessor — resolves the index name against the tracker at
      // apply time (in an Action, that's the engine's resolve context).
      const indexName = yield* index.indexName;
      return makeHttpSearchIndexClient(auth, indexName);
    });
  }),
);
