import type * as runtime from "@cloudflare/workers-types";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import { fetchWithFetcher } from "./FetcherRequest.ts";
import { isWorker, type Worker, WorkerEnvironment } from "./Worker.ts";

/**
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export interface Fetch extends Binding.Service<
  Fetch,
  "Cloudflare.Workers.Fetch",
  (
    worker: Worker,
  ) => Effect.Effect<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.RequestError,
      RuntimeContext
    >
  >
> {}

export const Fetch = Binding.Service<Fetch>("Cloudflare.Workers.Fetch");

export const FetchBinding = Layer.effect(
  Fetch,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (worker: Worker) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Deploy-time only: register the service binding for the *target*
        // worker on the host Worker.
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          yield* host.bind`${worker}`({
            bindings: [
              {
                type: "service",
                name: worker.LogicalId,
                service: worker.workerName,
              },
            ],
          });
        }
      }
      // Lazy — the `WorkerEnvironment` bindings are only populated at exec
      // phase, so the fetcher must be resolved per call, not at bind time.
      const fetcher = Effect.sync(
        () => (env as Record<string, runtime.Fetcher>)[worker.LogicalId]!,
      ) as Effect.Effect<runtime.Fetcher, never, RuntimeContext>;

      return (request: HttpClientRequest.HttpClientRequest) =>
        Effect.flatMap(fetcher, (f) =>
          fetchWithFetcher(f, request, "Service binding fetch failed"),
        );
    });
  }),
);
