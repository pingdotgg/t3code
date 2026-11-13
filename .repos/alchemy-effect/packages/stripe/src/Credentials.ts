import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/stripe";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { STRIPE_AUTH_PROVIDER_NAME, type StripeResolvedCredentials } from "./AuthProvider.ts";

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
    lazyCredentials<StripeResolvedCredentials, ConfigError>()(
      STRIPE_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ),
  );
