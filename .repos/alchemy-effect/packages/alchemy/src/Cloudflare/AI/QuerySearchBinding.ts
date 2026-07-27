import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { makeClient, QuerySearch } from "./QuerySearch.ts";
import type { SearchInstance } from "./SearchInstance.ts";

/**
 * Runtime layer for {@link QuerySearch}.
 */
export const QuerySearchBinding = Layer.effect(
  QuerySearch,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (instance: SearchInstance) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${instance}`({
          bindings: [
            {
              type: "ai_search",
              name: instance.LogicalId,
              instanceName: instance.instanceId,
              namespace: instance.namespace,
            },
          ],
        });
      }

      const rawEff = Effect.sync(
        () =>
          (env as Record<string, runtime.AiSearchInstance>)[
            instance.LogicalId
          ]!,
      );
      return makeClient(rawEff);
    });
  }),
);
