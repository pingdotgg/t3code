import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/neon";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { NEON_AUTH_PROVIDER_NAME, type NeonResolvedCredentials } from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/neon";

const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<NeonResolvedCredentials, ConfigError>()(NEON_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiKey,
      apiBaseUrl: DEFAULT_BASE_URL,
    })),
  );
