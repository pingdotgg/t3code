import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/hetzner";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { HETZNER_AUTH_PROVIDER_NAME, type HetznerResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
} from "@distilled.cloud/hetzner";

/**
 * Build a `Credentials` layer that resolves Hetzner credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/hetzner`'s `{ token, apiBaseUrl }` shape.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<HetznerResolvedCredentials, ConfigError>()(
      HETZNER_AUTH_PROVIDER_NAME,
      (creds) => ({
        token: creds.token,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ),
  );
