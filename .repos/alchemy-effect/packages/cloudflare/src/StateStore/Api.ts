import crypto from "node:crypto";
import { DEFAULT_COMPATIBILITY_DATE } from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
  StateStoreFailure,
} from "alchemy/State/HttpStateApi";
import { Redacted } from "effect";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ReadSecret } from "../SecretsStore/ReadSecret.ts";
import { ReadSecretBinding } from "../SecretsStore/ReadSecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";
import Store, { retrySecretRead } from "./Store.ts";
import { AuthToken, DEFAULT_STATE_STORE_NAME, StateStoreName } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = DEFAULT_STATE_STORE_NAME;

/**
 * Version of the deployed Cloudflare State Store worker contract.
 *
 * Bump this whenever the wire format or runtime behaviour of the
 * worker changes in a way that an older deployed copy can no longer
 * satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
// v8: failures behind the auth middleware answer as a typed `StateStoreFailure`
// (v7 encoded them through `Unauthorized`'s schema and answered a bare 500),
// FQNs longer than 100 URI-encoded chars are routed, secret reads retry, and
// requests for the legacy bootstrap stack are refused.
export const STATE_STORE_VERSION = 8 as const;

/**
 * The stack older Alchemy versions deployed the store itself with. Those
 * versions redeploy a store they find out of date through this stack, and on a
 * store whose rows are missing they generate a new auth token and encryption
 * key and overwrite the existing secrets with them, losing all state. The
 * Worker refuses every request for this stack, so such a redeploy fails while
 * reading its state, before it touches a secret. Deleting the whole stack is
 * the exception: bootstrap removes its records so it can't be destroyed.
 */
const LEGACY_BOOTSTRAP_STACK = "CloudflareStateStore";

const isLegacyBootstrapRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const { pathname } = new URL(request.url, "http://store");
  const match = new RegExp(`^/state/stacks/${LEGACY_BOOTSTRAP_STACK}(/.*)?$`).exec(pathname);
  return match !== null && !(request.method === "DELETE" && match[1] === undefined);
};

const refuseLegacyBootstrap = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isLegacyBootstrapRequest(request)
      ? Effect.succeed(
          HttpServerResponse.text(
            `This Cloudflare State Store was deployed by a newer version of Alchemy. ` +
              `Upgrade alchemy to use it.`,
            { status: 409 },
          ),
        )
      : app,
  );

/**
 * Hard-coded OTLP/HTTP endpoints. Point at the public ingest relay
 * defined in `stacks/src/otel.ts` (bound to `otel.alchemy.run`), which
 * forwards to Axiom with the bearer token attached server-side. Hard-
 * coded on purpose: the worker has no env-var plumbing and the relay
 * is account-level infra that lives outside any single deploy.
 */
// const OTEL_TRACES_URL = "https://otel.alchemy.run/v1/traces";
// const OTEL_METRICS_URL = "https://otel.alchemy.run/v1/metrics";
// const OTEL_LOGS_URL = "https://otel.alchemy.run/v1/logs";

/**
 * OTLP traces + metrics + logs Layer for the state-store worker.
 * Mirrors the CLI's `TelemetryLive` so every signal the worker emits
 * (`Effect.withSpan`, runtime metrics, `Effect.log*`) ships to the
 * same Axiom datasets as deploy-time CLI signals. Resource attributes
 * brand each signal with the worker's service name + contract version
 * so they're easy to slice in Axiom.
 */
// const otelResource = {
//   serviceName: STATE_STORE_SCRIPT_NAME,
//   serviceVersion: String(STATE_STORE_VERSION),
//   attributes: {
//     "alchemy.state_store.script_name": STATE_STORE_SCRIPT_NAME,
//     "alchemy.state_store.version": STATE_STORE_VERSION,
//   },
// } as const;

// const TelemetryLive = Layer.mergeAll(
//   OtlpTracer.layer({
//     url: OTEL_TRACES_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//   }),
//   OtlpMetrics.layer({
//     url: OTEL_METRICS_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//   }),
//   // Replace (don't merge with) the default stdout logger so worker logs
//   // ship to Axiom instead of just `wrangler tail`.
//   OtlpLogger.layer({
//     url: OTEL_LOGS_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//     mergeWithExisting: false,
//   }),
// ).pipe(
//   Layer.provide(OtlpSerialization.layerJson),
//   Layer.provide(FetchHttpClient.layer),
// );

/** This module, the state-store Worker's bundling entry (see `Deploy.ts`). */
export const API_MAIN = import.meta.url;

/**
 * A failed Durable Object call, as the API's declared error: the operation and
 * the kind of failure for the client, the full cause in the Worker's logs.
 */
const failed =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, StateStoreFailure, R> =>
    effect.pipe(
      Effect.tapError((error) => Effect.logError(`State store ${operation} failed`, error)),
      Effect.mapError((error) =>
        StateStoreFailure.make({
          operation,
          reason:
            typeof error === "object" && error !== null && "_tag" in error
              ? String(error._tag)
              : "UnknownError",
        }),
      ),
    );

export default Worker(
  "Api",
  Effect.map(StateStoreName, (name) => ({
    name,
    main: API_MAIN,
    workersDev: true,
    compatibility: {
      date: DEFAULT_COMPATIBILITY_DATE,
    },
  })),
  Effect.gen(function* () {
    const remoteSecret = yield* ReadSecret(AuthToken);
    const store = yield* Store;

    const bearerTokenValidator = Layer.succeed(
      BearerTokenValidator,
      BearerTokenValidator.of({
        validate: Effect.fn(function* (token) {
          const expected = yield* remoteSecret
            .get()
            .pipe(retrySecretRead, Effect.orDie, Effect.provide(RuntimeContext.phantom));
          return !!expected && timingSafeEqual(token.trim(), Redacted.value(expected).trim())
            ? yield* Effect.void
            : yield* HttpApiError.Unauthorized.make({});
        }),
      }),
    );

    const versionApi = HttpApiBuilder.group(StateApi, "version", (handlers) =>
      handlers.handle("getVersion", () =>
        Effect.succeed({ version: STATE_STORE_VERSION }).pipe(
          Effect.withSpan("state_store.getVersion", {
            attributes: { "alchemy.state_store.op": "getVersion" },
          }),
        ),
      ),
    );

    const stateApi = HttpApiBuilder.group(StateApi, "state", (handlers) =>
      handlers
        .handle("listStacks", () =>
          store
            .getByName(Store.ROOT_DO_NAME)
            .listStacks()
            .pipe(
              failed("listStacks"),
              Effect.withSpan("state_store.listStacks", {
                attributes: { "alchemy.state_store.op": "listStacks" },
              }),
            ),
        )
        .handle("listStages", ({ params }) =>
          store
            .getByName(params.stack)
            .listStages()
            .pipe(
              failed("listStages"),
              Effect.withSpan("state_store.listStages", {
                attributes: {
                  "alchemy.state_store.op": "listStages",
                  "alchemy.state_store.stack": params.stack,
                },
              }),
            ),
        )
        .handle("listResources", ({ params }) =>
          store
            .getByName(params.stack)
            .listResources({ stage: params.stage })
            .pipe(
              failed("listResources"),
              Effect.withSpan("state_store.listResources", {
                attributes: {
                  "alchemy.state_store.op": "listResources",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getState", ({ params }) => {
          const fqn = decodeURIComponent(params.fqn);
          return store
            .getByName(params.stack)
            .get({ stage: params.stage, fqn })
            .pipe(
              failed("getState"),
              Effect.withSpan("state_store.getState", {
                attributes: {
                  "alchemy.state_store.op": "getState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("setState", ({ params, payload }) => {
          const fqn = decodeURIComponent(params.fqn);
          return store
            .getByName(params.stack)
            .set({ stage: params.stage, fqn, value: payload as any })
            .pipe(
              Effect.tap(() =>
                store.getByName(Store.ROOT_DO_NAME).registerStack({ stack: params.stack }),
              ),
              failed("setState"),
              Effect.withSpan("state_store.setState", {
                attributes: {
                  "alchemy.state_store.op": "setState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("deleteState", ({ params }) => {
          const fqn = decodeURIComponent(params.fqn);
          // The DO method is `remove`, not `delete` — `delete` is
          // reserved by Cloudflare's RPC stub proxy.
          return store
            .getByName(params.stack)
            .remove({ stage: params.stage, fqn })
            .pipe(
              Effect.asVoid,
              failed("deleteState"),
              Effect.withSpan("state_store.deleteState", {
                attributes: {
                  "alchemy.state_store.op": "deleteState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("getReplacedResources", ({ params }) =>
          store
            .getByName(params.stack)
            .getReplacedResources({ stage: params.stage })
            .pipe(
              failed("getReplacedResources"),
              Effect.withSpan("state_store.getReplacedResources", {
                attributes: {
                  "alchemy.state_store.op": "getReplacedResources",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getStackOutput", ({ params }) =>
          store
            .getByName(params.stack)
            .getOutput({ stage: params.stage })
            .pipe(
              failed("getStackOutput"),
              Effect.withSpan("state_store.getStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "getStackOutput",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("setStackOutput", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .setOutput({ stage: params.stage, value: payload as any })
            .pipe(
              Effect.tap(() =>
                store.getByName(Store.ROOT_DO_NAME).registerStack({ stack: params.stack }),
              ),
              failed("setStackOutput"),
              Effect.withSpan("state_store.setStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "setStackOutput",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("deleteStack", ({ params, query }) =>
          store
            .getByName(params.stack)
            .deleteStack(query.stage === undefined ? {} : { stage: query.stage })
            .pipe(
              Effect.flatMap(() =>
                query.stage === undefined
                  ? store.getByName(Store.ROOT_DO_NAME).unregisterStack({ stack: params.stack })
                  : Effect.void,
              ),
              Effect.asVoid,
              failed("deleteStack"),
              Effect.withSpan("state_store.deleteStack", {
                attributes: {
                  "alchemy.state_store.op": "deleteStack",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": query.stage ?? "",
                  "alchemy.state_store.scope": query.stage === undefined ? "stack" : "stage",
                },
              }),
            ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(StateApi).pipe(
        Layer.provide(stateApi),
        Layer.provide(versionApi),
        Layer.provide(StateAuthLive),
        Layer.provide(bearerTokenValidator),
        // The state-store worker never serves files, so HttpPlatform's
        // file-response surface is stubbed.
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        // An FQN travels as one URI-encoded path segment, and the router's
        // default 100-char cap on a parameter left a longer one unrouted.
        Effect.provideService(HttpRouter.RouterConfig, { maxParamLength: MAX_PARAM_LENGTH }),
        Effect.map(refuseLegacyBootstrap),
        // Effect.provide(TelemetryLive),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(ReadSecretBinding))),
);

/**
 * Longest path parameter the worker routes, within a Cloudflare URL's 16 KiB.
 */
const MAX_PARAM_LENGTH = 16_384;

/**
 * Stub `HttpPlatform` for the worker. The state-store API never
 * issues file responses, so both surface methods die if invoked. Lets
 * us avoid pulling in a `FileSystem` dependency that workers don't
 * have.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  // Advertises no algorithms, so the compression middleware never engages
  // and compressResponse is never called.
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

/**
 * Timing-safe string comparison using the Workers runtime's built-in
 * `crypto.subtle.timingSafeEqual`.
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  // @ts-expect-error - TODO(sam)
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};
