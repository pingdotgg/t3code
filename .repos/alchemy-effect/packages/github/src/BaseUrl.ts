import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/github/Credentials";
import type { ConfigError } from "@distilled.cloud/github/Errors";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv } from "alchemy/Auth/Env";
import * as Effect from "effect/Effect";

/**
 * Normalize a user-supplied GitHub host or URL into the REST API base URL
 * the GitHub SDK expects, following the same conventions as the `gh` CLI and the
 * Terraform GitHub provider:
 *
 * - `github.com` / `api.github.com` → `undefined` (the github.com default)
 * - GitHub Enterprise Cloud with data residency (`acme.ghe.com` or
 *   `api.acme.ghe.com`) → `https://api.acme.ghe.com`
 * - GitHub Enterprise Server (`github.example.com`) → `https://github.example.com/api/v3`;
 *   an explicit path (e.g. an already-complete `/api/v3` URL) is honored as-is.
 *
 * Accepts a bare hostname or a full URL.
 */
export const normalizeGitHubBaseUrl = (
  input: string,
): Effect.Effect<string | undefined, AuthError> =>
  Effect.try({
    try: () => {
      const trimmed = input.trim();
      const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      const host = url.hostname.toLowerCase();
      if (host === "github.com" || host === "www.github.com" || host === "api.github.com") {
        return undefined;
      }
      if (host.endsWith(".ghe.com")) {
        return `https://${host.startsWith("api.") ? host : `api.${host}`}`;
      }
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host}${path === "" ? "/api/v3" : path}`;
    },
    catch: () =>
      AuthError.make({
        message: `Invalid GitHub base URL: '${input}'. Provide a hostname (github.example.com) or URL (https://github.example.com/api/v3).`,
      }),
  });

/**
 * The hostname `gh auth token --hostname` expects for a normalized API base
 * URL — the plain host for GitHub Enterprise Server, and the `api.`-less
 * host for GitHub Enterprise Cloud with data residency.
 */
export const githubHostname = (baseUrl: string): string => {
  const host = new URL(baseUrl).hostname;
  return host.startsWith("api.") && host.endsWith(".ghe.com") ? host.slice("api.".length) : host;
};

/**
 * Resolve the GitHub API base URL from the environment:
 * `GITHUB_BASE_URL` (Terraform convention), then `GITHUB_API_URL` (set by
 * GitHub Actions runners), then `GH_HOST` (gh CLI convention, a bare
 * hostname). Returns `undefined` when unset or when the value points at
 * github.com.
 */
export const resolveGitHubBaseUrlFromEnv: Effect.Effect<string | undefined, AuthError> = Effect.gen(
  function* () {
    for (const key of ["GITHUB_BASE_URL", "GITHUB_API_URL", "GH_HOST"]) {
      const value = yield* getEnv(key);
      if (value !== undefined && value.trim() !== "") {
        return yield* normalizeGitHubBaseUrl(value);
      }
    }
    return undefined;
  },
);

/**
 * Run a resource's GitHub calls against its own `baseUrl` prop. When set, it
 * is normalized and replaces the provider's host (an explicit `"github.com"`
 * overrides an enterprise-wide provider host back to the default); when
 * unset, the calls use the provider's credentials unchanged.
 *
 * ```ts
 * reconcile: Effect.fn(function* ({ news }) { ... }, (effect, { news }) =>
 *   effect.pipe(withBaseUrl(news.baseUrl)),
 * ),
 * ```
 */
export const withBaseUrl =
  (baseUrl: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | AuthError, R | Credentials> =>
    baseUrl === undefined
      ? effect
      : Effect.flatMap(normalizeGitHubBaseUrl(baseUrl), (apiBaseUrl) =>
          Effect.updateService(effect, Credentials, (resolve) =>
            Effect.map(resolve, (config) => ({
              ...config,
              apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
            })),
          ),
        );

/**
 * The REST API base URL a resource's `baseUrl` prop actually resolves to: the
 * normalized prop when set, otherwise the provider's host — which already
 * reflects `GitHub.providers({ baseUrl })` or the auth provider's resolved
 * host.
 */
export const effectiveGitHubBaseUrl = (
  baseUrl: string | undefined,
): Effect.Effect<string, AuthError | ConfigError, Credentials> =>
  baseUrl !== undefined
    ? Effect.map(normalizeGitHubBaseUrl(baseUrl), (url) => url ?? DEFAULT_API_BASE_URL)
    : Effect.gen(function* () {
        return (yield* yield* Credentials).apiBaseUrl;
      });

/**
 * Whether a resource's EFFECTIVE GitHub host changed between deploys — used
 * by resource `diff` implementations to decide replacement (a resource with
 * the same name on a different GitHub instance is a different physical
 * resource).
 *
 * Each side is resolved through the full fallback chain (explicit prop →
 * `providers({ baseUrl })` → auth provider host) and normalized before
 * comparing, so neither a cosmetic rewrite (`github.example.com` →
 * `https://github.example.com/api/v3`) nor making the ambient default
 * explicit (prop `undefined` → prop equal to the provider's host) triggers
 * a replacement — and dropping back to github.com from an enterprise-wide
 * provider host is correctly detected as a change.
 */
export const gitHubBaseUrlChanged = (
  olds: { baseUrl?: string },
  news: { baseUrl?: string },
): Effect.Effect<boolean, AuthError | ConfigError, Credentials> =>
  Effect.gen(function* () {
    const oldUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
    const newUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);
    return oldUrl !== newUrl;
  });
