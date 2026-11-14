import type { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  DEFAULT_API_BASE_URL,
  type Config,
} from "@distilled.cloud/github/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  GITHUB_AUTH_PROVIDER_NAME,
  type GitHubResolvedCredentials,
  readEnvCredentials,
} from "./AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";

export { Credentials } from "@distilled.cloud/github/Credentials";

declare module "@distilled.cloud/github/Credentials" {
  // Lets stack programs require it, e.g. an Action using a `GitHub.*Local` binding.
  interface Credentials {
    readonly kind: "Credentials";
  }
}

/** The User-Agent alchemy sends; GitHub rejects requests without one. */
export const USER_AGENT = "alchemy";

/**
 * Distilled credentials for a token on a REST API base URL (`undefined`, from
 * {@link normalizeGitHubBaseUrl}, is github.com).
 */
export const config = (
  token: Redacted.Redacted<string>,
  apiBaseUrl: string | undefined,
): Config => ({ token, apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL, userAgent: USER_AGENT });

/**
 * Build a `Credentials` layer from a literal token. Useful for
 * tests or when callers already have a PAT in hand.
 *
 * Pass `baseUrl` to target a GitHub Enterprise instance. It accepts a
 * hostname or URL and is normalized into the REST API base URL — a GitHub
 * Enterprise Server host gets `/api/v3` appended, a `*.ghe.com`
 * data-residency host gets the `api.` prefix.
 */
export const fromToken = (
  token: string | Redacted.Redacted<string>,
  options?: { readonly baseUrl?: string },
) =>
  Layer.succeed(
    Credentials,
    Effect.gen(function* () {
      const baseUrl =
        options?.baseUrl !== undefined ? yield* normalizeGitHubBaseUrl(options.baseUrl) : undefined;
      return config(typeof token === "string" ? Redacted.make(token) : token, baseUrl);
    }).pipe(Effect.orDie),
  );

/**
 * Build a `Credentials` layer that reads the token from
 * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` at layer build time.
 *
 * GitHub Enterprise is resolved from the environment too: `GITHUB_BASE_URL`,
 * `GITHUB_API_URL` (set by GitHub Actions runners), or `GH_HOST` select the
 * host, and on an enterprise host `GH_ENTERPRISE_TOKEN` /
 * `GITHUB_ENTERPRISE_TOKEN` are checked before the standard token variables.
 */
export const fromEnv = () =>
  Layer.succeed(
    Credentials,
    readEnvCredentials().pipe(
      Effect.map((creds) => config(creds.token, creds.baseUrl)),
      Effect.orDie,
    ),
  );

/**
 * Build a `Credentials` layer that resolves a token via the
 * Alchemy AuthProvider for the configured profile (defaults to
 * the current Alchemy profile).
 *
 * Pass `baseUrl` to hard-code the GitHub host — it takes precedence over
 * whatever host the auth provider resolved from the profile config or
 * environment. `GitHub.providers({ baseUrl })` threads its option here.
 */
export const fromAuthProvider = (options?: { readonly baseUrl?: string }) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const fixedBaseUrl =
        options?.baseUrl !== undefined
          ? { baseUrl: yield* normalizeGitHubBaseUrl(options.baseUrl) }
          : undefined;
      return yield* lazyCredentials<GitHubResolvedCredentials, ConfigError>()(
        GITHUB_AUTH_PROVIDER_NAME,
        (creds) =>
          config(creds.token, fixedBaseUrl !== undefined ? fixedBaseUrl.baseUrl : creds.baseUrl),
      );
    }).pipe(Effect.orDie),
  );
