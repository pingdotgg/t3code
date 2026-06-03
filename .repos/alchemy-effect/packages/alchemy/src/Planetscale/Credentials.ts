import {
  Credentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/planetscale/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  PLANETSCALE_AUTH_PROVIDER_NAME,
  type PlanetscaleAuthConfig,
  type PlanetscaleResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/planetscale/Credentials";

/**
 * Build a PlanetScale `Credentials` Layer from an explicit token. Useful for
 * tests or when the caller already has credentials in hand.
 *
 * @example
 * ```ts
 * Effect.provide(
 *   Planetscale.fromToken({
 *     tokenId: "abcd1234",
 *     token: "api-token-secret",
 *     organization: "my-org",
 *   }),
 * )
 * ```
 */
export const fromToken = (input: {
  tokenId: string | Redacted.Redacted<string>;
  token: string | Redacted.Redacted<string>;
  organization: string;
  apiBaseUrl?: string;
}) =>
  Layer.succeed(Credentials, {
    tokenId:
      typeof input.token === "string"
        ? Redacted.make(input.token)
        : input.token,
    token:
      typeof input.token === "string"
        ? Redacted.make(input.token)
        : input.token,
    organization: input.organization,
    apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
  });

/**
 * Build a PlanetScale `Credentials` Layer that resolves credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        PlanetscaleAuthConfig,
        PlanetscaleResolvedCredentials
      >(PLANETSCALE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const apiBaseUrl = yield* Config.string("PLANETSCALE_API_BASE_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      );

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as PlanetscaleAuthConfig),
        ),
        Effect.map((creds) => ({
          tokenId: creds.tokenId,
          token: creds.token,
          organization: creds.organization,
          apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Planetscale credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
      );
    }),
  );
