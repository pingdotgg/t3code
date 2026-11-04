import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FLY_AUTH_PROVIDER_NAME, type FlyResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  type Config as CredentialsConfig,
} from "@distilled.cloud/fly-io";

/**
 * Capture the deployment's org token as a named runtime Output.
 * Resolve it during binding initialization so plan/diff retains
 * profile-backed credentials rather than falling back to process env.
 */
export const bindFlyApiToken = (): Effect.Effect<void, never, Credentials> =>
  Effect.gen(function* () {
    const token = globalThis.__ALCHEMY_RUNTIME__
      ? ""
      : yield* Credentials.pipe(
          Effect.flatMap((resolve) => resolve),
          Effect.map((cfg) => Redacted.value(cfg.apiKey)),
          // Binding initialization cannot fail; the engine reports this
          // defect as `CredentialsRequired`.
          orDieCredentialsUnavailable("Fly"),
        );
    yield* Output.named(Output.asOutput(token), "FLY_API_TOKEN").asEffect().pipe(Effect.asVoid);
  });

/**
 * `Credentials` for the HTTP binding layers (`GetSecretHttp`, `ExecHttp`, …).
 *
 * Those layers are built in two places. Inside a stack (plan/deploy, or an
 * Action) `providers()` has already resolved the profile-backed
 * `Credentials`, and the binding must use them — a laptop deploy has no
 * `FLY_API_TOKEN` in its env once the token lives in the Alchemy profile.
 * Inside a deployed Machine there is no profile; `bindFlyApiToken`
 * has already `RuntimeContext.set` the org token, which Platform copies
 * into Machine env as `FLY_API_TOKEN`. So: reuse the ambient
 * `Credentials` when present, otherwise read the env.
 */
export const CredentialsFromAmbientOrEnv: Layer.Layer<Credentials> = Layer.effect(
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
    lazyCredentials<FlyResolvedCredentials, ConfigError>()(FLY_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiKey,
      apiBaseUrl: creds.apiBaseUrl,
    })),
  );
