import { ConfigError } from "@distilled.cloud/core/errors";
import {
  type Config as PlanetscaleClientConfig,
  Credentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/planetscale/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as CredentialsCache from "../Auth/CredentialsCache.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
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
  Layer.succeed(
    Credentials,
    Effect.succeed({
      tokenId:
        typeof input.tokenId === "string"
          ? Redacted.make(input.tokenId)
          : input.tokenId,
      token:
        typeof input.token === "string"
          ? Redacted.make(input.token)
          : input.token,
      organization: input.organization,
      apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

/**
 * Build a PlanetScale `Credentials` Layer that resolves credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * selected by the current Alchemy profile).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const apiBaseUrl = yield* Config.String("PLANETSCALE_API_BASE_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      );
      const { profileName, resolve } = yield* resolveProviderConfig<
        PlanetscaleAuthConfig,
        PlanetscaleResolvedCredentials
      >(PLANETSCALE_AUTH_PROVIDER_NAME);

      // Cache until shortly before the OAuth token expires (service tokens
      // never expire) so a long `alchemy dev` session re-resolves — and
      // thereby refreshes — the token instead of keeping the first, by then
      // dead, resolution forever. The cache wraps `resolve` (not the mapped
      // client config) because the mapping drops the `expires` timestamp.
      const cached = yield* CredentialsCache.cacheUntilExpiry(
        resolve,
        (creds) => (creds.type === "oauth" ? creds.expires : undefined),
      );
      return cached.pipe(
        Effect.map((creds): PlanetscaleClientConfig =>
          creds.type === "oauth"
            ? {
                type: "oauth",
                accessToken: creds.accessToken,
                organization: creds.organization,
                apiBaseUrl,
              }
            : {
                type: "serviceToken",
                tokenId: creds.tokenId,
                token: creds.token,
                organization: creds.organization,
                apiBaseUrl,
              },
        ),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Planetscale credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
      );
    }),
  );
