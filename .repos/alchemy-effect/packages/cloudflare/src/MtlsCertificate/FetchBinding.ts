import type * as runtime from "@cloudflare/workers-types";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { fetchWithFetcher } from "../Workers/FetcherRequest.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import { Fetch } from "./Fetch.ts";
import type { MtlsCertificate } from "./MtlsCertificate.ts";

/**
 * Implementation of {@link Fetch} over the native `mtls_certificate` Worker
 * binding. Provide it on the Worker's Effect.
 */
export const FetchBinding = Layer.effect(
  Fetch,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (certificate: MtlsCertificate) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Deploy-time only: attach the certificate to the host Worker.
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          yield* host.bind`${certificate}`({
            bindings: [
              {
                type: "mtls_certificate",
                name: certificate.LogicalId,
                certificateId: certificate.mtlsCertificateId,
              },
            ],
          });
        }
      }
      // Lazy: `WorkerEnvironment` bindings are only populated at runtime.
      const fetcher = Effect.sync(
        () => (env as Record<string, runtime.Fetcher>)[certificate.LogicalId]!,
      ) as Effect.Effect<runtime.Fetcher, never, RuntimeContext>;

      return (request: HttpClientRequest.HttpClientRequest) =>
        Effect.flatMap(fetcher, (f) =>
          fetchWithFetcher(f, request, "mTLS certificate fetch failed"),
        );
    });
  }),
);
