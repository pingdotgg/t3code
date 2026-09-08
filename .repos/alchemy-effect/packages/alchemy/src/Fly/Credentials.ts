import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/fly-io";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
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
 * Build a `Credentials` layer that resolves Fly credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/fly-io`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's own `CredentialsFromEnv` also accepts `FLY_IO_API_KEY` as a
 * fallback — Alchemy itself only reads `FLY_API_TOKEN`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        FlyAuthConfig,
        FlyResolvedCredentials
      >(FLY_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as FlyAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Fly credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
