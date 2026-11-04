import { Credentials } from "@distilled.cloud/axiom/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { AXIOM_AUTH_PROVIDER_NAME, type AxiomResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/axiom/Credentials";

/**
 * Build a `Credentials` layer that resolves Axiom credentials via the Alchemy
 * AuthProvider using the configured profile (defaults to "default", overridable
 * with the current Alchemy profile).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<AxiomResolvedCredentials, ConfigError>()(AXIOM_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiToken,
      apiBaseUrl: creds.apiBaseUrl,
      orgId: creds.orgId,
    })),
  );
