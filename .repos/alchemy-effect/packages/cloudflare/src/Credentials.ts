import {
  apiKeyCredentials,
  apiTokenCredentials,
  Credentials,
  oauthCredentials,
  type ResolvedCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as CredentialsCache from "alchemy/Auth/CredentialsCache";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthConfig.ts";

export { Credentials, fromEnv } from "@distilled.cloud/cloudflare/Credentials";

declare module "@distilled.cloud/cloudflare/Credentials" {
  interface Credentials {
    readonly kind: "Credentials";
  }
}

/**
 * Memoize a credentials-resolution effect until shortly before the resolved
 * credentials expire — see {@link CredentialsCache.cacheUntilExpiry} for the
 * caching rules. Non-OAuth credentials (API token / global key) never expire
 * and cache forever.
 */
export const cacheUntilExpiry = <E>(resolve: Effect.Effect<ResolvedCredentials, E>) =>
  CredentialsCache.cacheUntilExpiry(resolve, (credentials) =>
    credentials.type === "oauth" ? credentials.expiresAt : undefined,
  );

/** OAuth access tokens expire; API tokens and global keys never do. */
const expiresAt = (creds: CloudflareResolvedCredentials) =>
  creds.type === "oauth" ? creds.expires : undefined;

/**
 * Build a `Credentials` layer that resolves Cloudflare credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * selected by the current Alchemy profile).
 *
 * `auth.read` refreshes and persists expired OAuth tokens when it is re-run,
 * so expiry-aware caching (instead of caching the first resolution forever)
 * is what keeps long-lived dev sessions authenticated across the ~1h
 * access-token lifetime.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<CloudflareResolvedCredentials, ConfigError>()(
      CLOUDFLARE_AUTH_PROVIDER_NAME,
      (creds) =>
        Match.value(creds).pipe(
          Match.when({ type: "apiToken" }, (c) => apiTokenCredentials({ apiToken: c.apiToken })),
          Match.when({ type: "apiKey" }, (c) =>
            apiKeyCredentials({
              apiKey: c.apiKey,
              email: Redacted.value(c.email),
            }),
          ),
          Match.when({ type: "oauth" }, (c) =>
            oauthCredentials({
              accessToken: c.accessToken,
              expiresAt: c.expires,
            }),
          ),
          Match.exhaustive,
        ),
      { expiresAt },
    ),
  );
