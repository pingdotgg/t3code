import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  STRIPE_AUTH_PROVIDER_NAME,
  type StripeAuthConfig,
  type StripeResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
} from "@distilled.cloud/stripe";

/**
 * Build a Stripe `Credentials` layer that resolves credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/stripe`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's `Credentials` service is an `Effect<Config>` resolved per
 * request. Environment credentials (`STRIPE_API_KEY`) take precedence;
 * otherwise the selected profile is used.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { profileName, resolve } = yield* resolveProviderConfig<
        StripeAuthConfig,
        StripeResolvedCredentials
      >(STRIPE_AUTH_PROVIDER_NAME);

      return yield* resolve.pipe(
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Stripe credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
