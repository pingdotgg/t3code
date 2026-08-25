import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  DecodeError,
  HttpClientError,
} from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

/**
 * A freshly-deployed Cloudflare Worker is not instantly reachable over HTTP.
 * Its `workers.dev` route, the script, and each binding (R2 / D1 / DO / Secrets
 * Store) propagate to the edge independently and asynchronously, so the first
 * requests to a new URL can transiently return:
 *
 *  - `404` while the `workers.dev` subdomain / route is still propagating
 *    (Cloudflare serves its "There is nothing here yet" placeholder), or
 *  - `5xx` while the script is up but a binding it depends on isn't ready yet.
 *
 * This is ordinary eventual consistency that belongs at the call site, not in
 * the resource provider — the provider returning before every edge PoP has
 * converged is correct. Consumers ride out the window by retrying the request.
 */
export class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * Status codes that indicate the edge hasn't finished converging on a fresh
 * deploy. Deliberate client errors (`401`, `403`, `400`, …) are NOT in this
 * set, so assertions on those statuses still observe them immediately rather
 * than being retried away.
 */
const isColdStartStatus = (status: number): boolean =>
  status === 404 || status >= 500;

export interface WhenReadyOptions {
  /** Max retry attempts before surfacing {@link WorkerNotReady}. Default `20`. */
  times?: number;
}

/**
 * Execute an arbitrary {@link HttpClientRequest.HttpClientRequest}, retrying
 * through the Cloudflare cold-start window ({@link isColdStartStatus}) until the
 * Worker serves a non-transient response. The returned response can carry any
 * non-cold-start status (e.g. `200`, `202`, `401`) for the caller to assert on.
 */
export const executeWhenReady = (
  request: HttpClientRequest.HttpClientRequest,
  options?: WhenReadyOptions,
): Effect.Effect<HttpClientResponse, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        isColdStartStatus(response.status)
          ? Effect.fail(new WorkerNotReady({ status: response.status }))
          : Effect.succeed(response),
      ),
      Effect.retry({
        while: (error) => error instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(options?.times ?? 20),
        ]),
      }),
    );
  });

/**
 * Convenience wrapper over {@link executeWhenReady} for a plain `GET`.
 */
export const getWhenReady = (
  url: string,
  options?: WhenReadyOptions,
): Effect.Effect<HttpClientResponse, unknown, HttpClient.HttpClient> =>
  executeWhenReady(HttpClientRequest.get(url), options);

/**
 * Options for the edge-transient response guard applied by
 * {@link guardContentType} / {@link rpcClientLayer}. Pass per suite via
 * `Test.make({ http: { ... } })` or per call site.
 */
export interface EdgeGuardOptions {
  /**
   * Retry schedule for edge-transient responses (and transport errors).
   * Default: exponential from 500ms capped at 3s.
   */
  schedule?: Schedule.Schedule<unknown, unknown>;
  /** Max transport-level retry attempts. Default `5`. */
  times?: number;
}

const defaultGuardSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * Guard an `HttpClient` against edge-generated bodies on a freshly deployed
 * Worker URL.
 *
 * Protocol clients like effect RPC's `layerProtocolHttp` never inspect the
 * response status or content-type — they pipe the raw body straight into the
 * serialization parser, so every edge-generated HTML page (the workers.dev
 * placeholder, which serves with HTTP **200**; 1101/1102 error pages;
 * 429/1015 rate limits) surfaces as an opaque decode defect (e.g.
 * `RpcClientDefect: Error decoding HTTP response`).
 *
 * This transform rejects any response whose `content-type` doesn't match the
 * expected one as a typed `HttpClientError` that records the status + a body
 * snippet — so a failure names its cause — and retries the request through a
 * bounded schedule so callers ride out the cold-start window
 * ({@link WorkerNotReady} documents why this belongs at the call site).
 */
export const guardContentType =
  (contentType: string, options?: EdgeGuardOptions) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.transform((effect, request) =>
        Effect.flatMap(effect, (response) => {
          const observed = response.headers["content-type"] ?? "";
          if (observed.includes(contentType)) {
            return Effect.succeed(response);
          }
          return response.text.pipe(
            Effect.orElseSucceed(() => "<unreadable body>"),
            Effect.flatMap((body) =>
              Effect.fail(
                new HttpClientError({
                  reason: new DecodeError({
                    request,
                    response,
                    description: `expected "${contentType}", got "${observed}" (status ${response.status}): ${body.slice(0, 200)}`,
                  }),
                }),
              ),
            ),
          );
        }),
      ),
      HttpClient.retry({
        schedule: options?.schedule ?? defaultGuardSchedule,
        times: options?.times ?? 5,
      }),
    );

/**
 * A fetch-backed `HttpClient` layer wrapped with {@link guardContentType}.
 *
 * Deliberately a standalone layer rather than a transform of the ambient
 * test `HttpClient`: the ambient client also serves the engine's own cloud
 * API calls during `deploy`/`destroy` and distilled SDK calls in
 * `test.provider` bodies, which must NOT be subjected to this guard.
 */
export const guardedFetchLayer = (
  contentType: string,
  options?: EdgeGuardOptions,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(HttpClient.HttpClient)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return guardContentType(contentType, options)(client);
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Complete RPC-over-HTTP client transport for driving a deployed Worker:
 * `RpcClient.layerProtocolHttp` + the given serialization (ndjson by
 * default) + a {@link guardedFetchLayer} expecting that serialization's
 * content-type.
 *
 * ```ts
 * const client = yield* RpcClient.make(WorkerRpcs);
 * // ...
 * }).pipe(Effect.scoped, Effect.provide(Test.Http.rpcClientLayer(url)));
 * ```
 */
export const rpcClientLayer = (
  url: string,
  options?: EdgeGuardOptions & {
    /** RPC wire serialization. Default {@link RpcSerialization.ndjson}. */
    serialization?: RpcSerialization.RpcSerialization["Service"];
    /**
     * Set `false` to skip the edge guard entirely and use a plain fetch
     * transport — e.g. for a test that asserts on the raw edge behavior
     * itself. Default `true`.
     */
    guard?: boolean;
  },
): Layer.Layer<RpcClient.Protocol> => {
  const serialization = options?.serialization ?? RpcSerialization.ndjson;
  return RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(
      options?.guard === false
        ? FetchHttpClient.layer
        : guardedFetchLayer(serialization.contentType, options),
    ),
    Layer.provide(
      Layer.succeed(RpcSerialization.RpcSerialization, serialization),
    ),
  );
};
