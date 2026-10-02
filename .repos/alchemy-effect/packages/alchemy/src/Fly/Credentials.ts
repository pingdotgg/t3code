import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  FLY_AUTH_PROVIDER_NAME,
  type FlyAuthConfig,
  type FlyResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  type Config as CredentialsConfig,
} from "@distilled.cloud/fly-io";

/**
 * `Credentials` for the HTTP binding layers (`GetSecretHttp`, `ExecHttp`, …).
 *
 * Those layers are built in two places. Inside a stack (plan/deploy, or an
 * Action) `providers()` has already resolved the profile-backed
 * `Credentials`, and the binding must use them — a laptop deploy has no
 * `FLY_API_TOKEN` in its env once the token lives in the Alchemy profile.
 * Inside a deployed Machine there is no profile; the host injected
 * `FLY_API_TOKEN` into the process env (see `SecretHttp.ts`). So: reuse the
 * ambient `Credentials` when present, otherwise read the env.
 */
export const CredentialsFromAmbientOrEnv: Layer.Layer<Credentials> =
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const ambient = yield* Effect.serviceOption(Credentials);
      if (Option.isSome(ambient)) return ambient.value;
      return yield* Credentials.pipe(Effect.provide(CredentialsFromEnv));
    }),
  );

/**
 * Build a `Credentials` layer that resolves Fly credentials via the current
 * Alchemy profile, or directly from environment variables in CI.
 *
 * Maps onto `@distilled.cloud/fly-io`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's own `CredentialsFromEnv` also accepts `FLY_IO_API_KEY` as a
 * fallback — Alchemy itself only reads `FLY_API_TOKEN`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        FlyAuthConfig,
        FlyResolvedCredentials
      >(FLY_AUTH_PROVIDER_NAME);

      return yield* resolve.pipe(
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Fly credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
