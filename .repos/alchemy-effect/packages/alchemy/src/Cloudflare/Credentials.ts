import {
  apiKeyCredentials,
  apiTokenCredentials,
  Credentials,
  oauthCredentials,
  type ResolvedCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

export { Credentials, fromEnv } from "@distilled.cloud/cloudflare/Credentials";

declare module "@distilled.cloud/cloudflare/Credentials" {
  interface Credentials {
    readonly kind: "Credentials";
  }
}

/**
 * Refresh OAuth credentials this long before they actually expire so that
 * in-flight requests never race the expiry deadline.
 */
const CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const getRefreshAt = (
  credentials: ResolvedCredentials,
  now: number,
): number => {
  if (credentials.type !== "oauth" || credentials.expiresAt === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return credentials.expiresAt <= now + CREDENTIAL_REFRESH_WINDOW_MS
    ? credentials.expiresAt
    : credentials.expiresAt - CREDENTIAL_REFRESH_WINDOW_MS;
};

/**
 * Memoize a credentials-resolution effect until shortly before the resolved
 * credentials expire.
 *
 * The distilled HTTP client resolves the `Credentials` service's effect on
 * *every* request (`yield* config.credentials`), which is what allows OAuth
 * tokens to rotate mid-process — a dev session can outlive the ~1h access
 * token, so caching the first resolution forever leaves the process making
 * API calls with a dead token until restart. At the same time, resolution
 * acquires a cross-process file lock (`auth.read`), so resolving fresh on
 * every request would stampede that lock under high concurrency (e.g.
 * `unsafe nuke`).
 *
 * This cache serves both needs: callers get the cached credentials while
 * they are still valid, the resolver re-runs (refreshing + persisting the
 * token) once the refresh window is reached, and a mutex makes resolution
 * single-flight so concurrent callers share one lock acquisition.
 */
export const cacheUntilExpiry = <E>(
  resolve: Effect.Effect<ResolvedCredentials, E>,
  now: () => number = () => Date.now(),
): Effect.Effect<ResolvedCredentials, E> => {
  const mutex = Semaphore.makeUnsafe(1);
  let cached:
    | { credentials: ResolvedCredentials; refreshAt: number }
    | undefined;
  return Semaphore.withPermits(
    mutex,
    1,
  )(
    Effect.suspend(() => {
      if (cached && now() < cached.refreshAt) {
        return Effect.succeed(cached.credentials);
      }
      return Effect.map(resolve, (credentials) => {
        cached = { credentials, refreshAt: getRefreshAt(credentials, now()) };
        return credentials;
      });
    }),
  );
};

/**
 * Build a `Credentials` layer that resolves Cloudflare credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      const resolve = profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as CloudflareAuthConfig),
        ),
        Effect.map((creds) =>
          Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) =>
              apiTokenCredentials({
                apiToken: Redacted.value(c.apiToken),
              }),
            ),
            Match.when({ type: "apiKey" }, (c) =>
              apiKeyCredentials({
                apiKey: Redacted.value(c.apiKey),
                email: Redacted.value(c.email),
              }),
            ),
            Match.when({ type: "oauth" }, (c) =>
              oauthCredentials({
                accessToken: Redacted.value(c.accessToken),
                expiresAt: c.expires,
              }),
            ),
            Match.exhaustive,
          ),
        ),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Cloudflare credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
      );

      // `auth.read` refreshes and persists expired OAuth tokens when it is
      // re-run, so expiry-aware caching (instead of caching the first
      // resolution forever) is what keeps long-lived dev sessions
      // authenticated across the ~1h access-token lifetime.
      return cacheUntilExpiry(resolve);
    }),
  );
