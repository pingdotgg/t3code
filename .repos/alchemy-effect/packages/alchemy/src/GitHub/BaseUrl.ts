import * as Effect from "effect/Effect";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv } from "../Auth/Env.ts";

/**
 * Normalize a user-supplied GitHub host or URL into the REST API base URL
 * Octokit expects, following the same conventions as the `gh` CLI and the
 * Terraform GitHub provider:
 *
 * - `github.com` / `api.github.com` → `undefined` (Octokit's default)
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
      const url = new URL(
        trimmed.includes("://") ? trimmed : `https://${trimmed}`,
      );
      const host = url.hostname.toLowerCase();
      if (
        host === "github.com" ||
        host === "www.github.com" ||
        host === "api.github.com"
      ) {
        return undefined;
      }
      if (host.endsWith(".ghe.com")) {
        return `https://${host.startsWith("api.") ? host : `api.${host}`}`;
      }
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host}${path === "" ? "/api/v3" : path}`;
    },
    catch: () =>
      new AuthError({
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
  return host.startsWith("api.") && host.endsWith(".ghe.com")
    ? host.slice("api.".length)
    : host;
};

/**
 * Resolve the GitHub API base URL from the environment:
 * `GITHUB_BASE_URL` (Terraform convention), then `GITHUB_API_URL` (set by
 * GitHub Actions runners), then `GH_HOST` (gh CLI convention, a bare
 * hostname). Returns `undefined` when unset or when the value points at
 * github.com.
 */
export const resolveGitHubBaseUrlFromEnv: Effect.Effect<
  string | undefined,
  AuthError
> = Effect.gen(function* () {
  for (const key of ["GITHUB_BASE_URL", "GITHUB_API_URL", "GH_HOST"]) {
    const value = yield* getEnv(key);
    if (value !== undefined && value.trim() !== "") {
      return yield* normalizeGitHubBaseUrl(value);
    }
  }
  return undefined;
});
