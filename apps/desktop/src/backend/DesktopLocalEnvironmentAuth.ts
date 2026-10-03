import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

// The renderer's cookie-session bootstrap retries transient failures for
// ~15s (see retryTransientBootstrap in apps/web/src/environments/primary/auth.ts).
// The main-process bearer exchange had no such retry, so a single transient
// /oauth/token failure (a first-request connection reset on a new OS, a
// loopback quirk, a brief 503 while the backend settles) hard-crashed the app
// via DesktopLocalEnvironmentAuthSessionBootstrapError. Mirror the renderer's
// transient classification here so the bearer path degrades the same way.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(15);
const BOOTSTRAP_TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);

// `executeEnvironmentHttpRequest` normalizes every failure into a
// `RemoteEnvironmentRequestError` (a union of Data.TaggedError shapes from
// packages/client-runtime/src/rpc/http.ts). Declared server errors keep their
// own `_tag`; transport failures become `RemoteEnvironmentAuthFetchError`;
// undeclared HTTP statuses become `RemoteEnvironmentAuthUndeclaredStatusError`.
// Classify by `_tag` so we don't need value imports of the error constructors.
const isTransientBearerBootstrapError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false;
  const tag = (error as { readonly _tag?: unknown })._tag;
  if (typeof tag !== "string") return false;
  // Declared EnvironmentHttp errors with a known non-transient status. The
  // token endpoint wraps internal failures in EnvironmentInternalError (500),
  // credential problems in EnvironmentAuthInvalidError (401), and bad requests
  // in EnvironmentRequestInvalidError (400). None of these are transient.
  if (
    tag === "EnvironmentInternalError" ||
    tag === "EnvironmentAuthInvalidError" ||
    tag === "EnvironmentRequestInvalidError"
  ) {
    return false;
  }
  // Undeclared HTTP statuses: transient only for 502/503/504.
  if (tag === "RemoteEnvironmentAuthUndeclaredStatusError") {
    const status = (error as { readonly status?: number }).status;
    return typeof status === "number" && TRANSIENT_BOOTSTRAP_STATUS_CODES.has(status);
  }
  // A transport-level fetch failure (connection reset, ECONNREFUSED while the
  // loopback listener is still coming up, an undici quirk on a new OS) surfaces
  // as RemoteEnvironmentAuthFetchError. Treat these as transient so the bearer
  // exchange rides out a brief loopback hiccup instead of crashing the app.
  if (tag === "RemoteEnvironmentAuthFetchError") {
    return true;
  }
  if (tag === "RemoteEnvironmentAuthTimeoutError") {
    return true;
  }
  // Effect's HttpClientError carries a response status for status-code errors.
  const maybeResponse = (error as { readonly response?: { readonly status: number } }).response;
  if (maybeResponse !== undefined && TRANSIENT_BOOTSTRAP_STATUS_CODES.has(maybeResponse.status)) {
    return true;
  }
  // Node fetch throws a TypeError on a network-level failure (DNS, refused,
  // reset). The renderer's isTransientBootstrapError treats TypeError as
  // transient; mirror that for the main-process undici client.
  return error instanceof TypeError;
};

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const credential = config.bootstrap.desktopBootstrapToken;
        if (!credential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential,
          clientMetadata: {
            label: "T3 Code Desktop",
            deviceType: "desktop",
          },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // Retry transient failures (502/503/504, transport-level fetch errors,
          // timeouts, TypeErrors) before surfacing the bootstrap error. A single
          // transient /oauth/token failure no longer hard-crashes the app; the
          // renderer's cookie path already had this resilience. spaced(500ms) +
          // upTo(15s) gives ~30 attempts in a 15s window.
          Effect.retry({
            while: isTransientBearerBootstrapError,
            schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL).pipe(
              Schedule.upTo({ duration: BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT }),
            ),
          }),
          // Schedule.upTo only bounds when retries are *scheduled*, not an
          // in-flight request: an attempt starting near the 15s mark could run
          // for its own per-request timeout, leaving getBearerToken blocked for
          // ~20s+. Bound the entire retrying effect so a hung request is
          // interrupted at the deadline and mapped to the bootstrap error below.
          Effect.timeout(BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
