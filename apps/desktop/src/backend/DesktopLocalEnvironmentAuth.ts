import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuthTokenStore from "./DesktopLocalEnvironmentAuthTokenStore.ts";

interface CachedBearerToken {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export class DesktopLocalEnvironmentAuthSessionValidationError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionValidationError>()(
  "DesktopLocalEnvironmentAuthSessionValidationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to validate the saved local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
  DesktopLocalEnvironmentAuthSessionValidationError,
  DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStoreError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const tokenStore =
    yield* DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenRef = yield* Ref.make(Option.none<CachedBearerToken>());
  const mutex = yield* Semaphore.make(1);

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (
          Option.isSome(cached) &&
          cached.value.expiresAtEpochMs > (yield* Clock.currentTimeMillis)
        ) {
          return cached.value.token;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const persistedToken = yield* tokenStore.get;
        if (Option.isSome(persistedToken)) {
          const session = yield* fetchRemoteSessionState({
            httpBaseUrl: config.httpBaseUrl.href,
            bearerToken: persistedToken.value,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.mapError(
              (cause) =>
                new DesktopLocalEnvironmentAuthSessionValidationError({
                  cause,
                }),
            ),
          );
          if (session.authenticated && session.expiresAt !== undefined) {
            const expiresAtEpochMs = session.expiresAt.epochMilliseconds;
            if (expiresAtEpochMs > (yield* Clock.currentTimeMillis)) {
              yield* Ref.set(
                tokenRef,
                Option.some({ token: persistedToken.value, expiresAtEpochMs }),
              );
              return persistedToken.value;
            }
          }
          yield* tokenStore.clear.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not clear the stale desktop authorization token.", {
                error,
              }),
            ),
          );
        }

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
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* tokenStore.set(session.access_token).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save the desktop authorization token.", {
              error,
            }).pipe(Effect.as(false)),
          ),
        );
        yield* Ref.set(
          tokenRef,
          Option.some({
            token: session.access_token,
            expiresAtEpochMs: (yield* Clock.currentTimeMillis) + session.expires_in * 1_000,
          }),
        );
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
