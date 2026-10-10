import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

// A loopback /oauth/token exchange can fail transiently while the backend
// settles (a 502-504, a refused or reset connection, a timeout). Retry those
// for as long as the renderer's own bootstrap does; a rejected credential or a
// server error is final.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(15);
const BOOTSTRAP_TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);

const isTransientBearerBootstrapError = (error: RemoteEnvironmentRequestError): boolean => {
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return true;
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
    default:
      return false;
  }
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
        // A backend launched with the desktop secret accepts the current
        // window's token, not the one frozen into its launch config; this
        // exchange can run long after launch (e.g. after a suspend).
        const secret = config.bootstrap.desktopBootstrapSecret;
        const credential =
          secret === undefined
            ? config.bootstrap.desktopBootstrapToken
            : currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
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
          Effect.retry({
            while: isTransientBearerBootstrapError,
            schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL),
          }),
          // Bounds the attempts and any request still in flight at the deadline.
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
