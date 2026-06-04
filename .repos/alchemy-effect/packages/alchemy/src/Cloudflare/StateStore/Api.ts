import { Redacted } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import crypto from "node:crypto";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
} from "../../State/HttpStateApi.ts";
import { Secret } from "../SecretsStore/Secret.ts";
import { SecretBindingLive } from "../SecretsStore/SecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";
import Store from "./Store.ts";
import { AuthToken } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/**
 * Version of the deployed Cloudflare State Store worker contract.
 *
 * Bump this whenever the wire format or runtime behaviour of the
 * worker changes in a way that an older deployed copy can no longer
 * satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 7 as const;

/**
 * Hard-coded OTLP/HTTP endpoints. Point at the public ingest relay
 * defined in `stacks/otel.ts` (bound to `otel.alchemy.run`), which
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

/**
 * Path on disk to *this* file, used as the worker's bundling entry.
 *
 * When running from source (e.g. dev / monorepo), `import.meta.url` points
 * at `Api.ts` and we can use it directly. When the alchemy CLI is run from
 * its published `bin/alchemy.js` bundle, this module is inlined into the
 * CLI bundle and `import.meta.url` resolves to `bin/alchemy.js` — which
 * has no `default` export and breaks the worker bundler with
 * `[MISSING_EXPORT] "default" is not exported by "bin/alchemy.js"`.
 *
 * In the bundled case, fall back to the published source file shipped
 * alongside the CLI under `../src/Cloudflare/StateStore/Api.ts`.
 */
export default Worker(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.filename,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const remoteSecret = yield* Secret.bind(AuthToken);
    const store = yield* Store;

    const bearerTokenValidator = Layer.succeed(
      BearerTokenValidator,
      BearerTokenValidator.of({
        // @ts-expect-error - TODO(sam): fix RuntimeContext color here
        validate: Effect.fnUntraced(function* (token) {
          const expected = yield* remoteSecret.get();
          return !!expected &&
            timingSafeEqual(token.trim(), Redacted.value(expected).trim())
            ? yield* Effect.void
            : yield* Effect.fail(new HttpApiError.Unauthorized());
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
                store
                  .getByName(Store.ROOT_DO_NAME)
                  .registerStack({ stack: params.stack }),
              ),
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
                store
                  .getByName(Store.ROOT_DO_NAME)
                  .registerStack({ stack: params.stack }),
              ),
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
            .deleteStack(
              query.stage === undefined ? {} : { stage: query.stage },
            )
            .pipe(
              Effect.flatMap(() =>
                query.stage === undefined
                  ? store
                      .getByName(Store.ROOT_DO_NAME)
                      .unregisterStack({ stack: params.stack })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.withSpan("state_store.deleteStack", {
                attributes: {
                  "alchemy.state_store.op": "deleteStack",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": query.stage ?? "",
                  "alchemy.state_store.scope":
                    query.stage === undefined ? "stack" : "stage",
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
        // Effect.provide(TelemetryLive),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(SecretBindingLive))),
);

/**
 * Stub `HttpPlatform` for the worker. The state-store API never
 * issues file responses, so both surface methods die if invoked. Lets
 * us avoid pulling in a `FileSystem` dependency that workers don't
 * have.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
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
