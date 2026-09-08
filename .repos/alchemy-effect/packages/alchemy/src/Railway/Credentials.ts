import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, toConfig } from "@distilled.cloud/railway";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  RAILWAY_AUTH_PROVIDER_NAME,
  type RailwayAuthConfig,
  type RailwayResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  CredentialsFromToken,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
  type TokenKind,
} from "@distilled.cloud/railway";

/**
 * Build a `Credentials` layer that resolves Railway credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/railway`'s
 * `{ token, tokenKind: "account", apiBaseUrl }` shape. Alchemy itself only
 * reads `RAILWAY_API_TOKEN` (account Bearer). Distilled's own
 * `CredentialsFromEnv` also accepts `RAILWAY_TOKEN` / `RAILWAY_PROJECT_TOKEN`
 * as fallbacks.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        RailwayAuthConfig,
        RailwayResolvedCredentials
      >(RAILWAY_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as RailwayAuthConfig),
        ),
        Effect.map((creds) =>
          toConfig({
            token: Redacted.value(creds.token),
            tokenKind: creds.tokenKind,
            apiBaseUrl: creds.apiBaseUrl,
          }),
        ),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Railway credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
