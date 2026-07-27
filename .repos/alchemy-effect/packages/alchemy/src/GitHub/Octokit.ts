import type { Octokit as _Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import type { AuthError } from "../Auth/AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { GitHubCredentials } from "./Credentials.ts";

export const Octokit: Effect.Effect<_Octokit, never, GitHubCredentials> =
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    return creds.octokit();
  });

/**
 * An Octokit honoring a per-resource `baseUrl` prop. When `baseUrl` is set,
 * it is normalized and used for this Octokit only (including an explicit
 * `"github.com"`, which overrides an enterprise-wide credential host back to
 * the default). When unset, falls back to the credentials' host — the
 * `GitHub.providers({ baseUrl })` hard-code or the auth provider's resolved
 * host.
 */
export const octokitFor = (
  baseUrl: string | undefined,
): Effect.Effect<_Octokit, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    return baseUrl === undefined
      ? creds.octokit()
      : creds.octokit({ baseUrl: yield* normalizeGitHubBaseUrl(baseUrl) });
  });

/**
 * The host a resource's `baseUrl` prop actually resolves to: the normalized
 * prop when set, otherwise the credentials' host — which already reflects
 * `GitHub.providers({ baseUrl })` or the auth provider's resolved host.
 */
export const effectiveGitHubBaseUrl = (
  baseUrl: string | undefined,
): Effect.Effect<string | undefined, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    if (baseUrl !== undefined) {
      return yield* normalizeGitHubBaseUrl(baseUrl);
    }
    const creds = yield* yield* GitHubCredentials;
    return creds.baseUrl;
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
 * explicit (prop `undefined` → prop equal to the credentials' host) triggers
 * a replacement — and dropping back to github.com from an enterprise-wide
 * credential host is correctly detected as a change.
 */
export const gitHubBaseUrlChanged = (
  olds: { baseUrl?: string },
  news: { baseUrl?: string },
): Effect.Effect<boolean, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    const oldUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
    const newUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);
    return oldUrl !== newUrl;
  });
