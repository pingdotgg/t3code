import { Octokit } from "@octokit/rest";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  GITHUB_AUTH_PROVIDER_NAME,
  type GitHubAuthConfig,
  type GitHubResolvedCredentials,
  readEnvCredentials,
} from "./AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";

export interface GitHubCredentialsService {
  readonly token: Redacted.Redacted<string>;
  /**
   * REST API base URL for GitHub Enterprise (e.g.
   * `https://github.example.com/api/v3` for GitHub Enterprise Server, or
   * `https://api.acme.ghe.com` for GitHub Enterprise Cloud with data
   * residency). `undefined` targets github.com.
   */
  readonly baseUrl?: string;
  /**
   * Construct an Octokit for these credentials. Pass `override` to target a
   * different host than the credentials' own `baseUrl` — `override.baseUrl`
   * is used verbatim, including `undefined` for github.com (which is why the
   * override is an object rather than an optional string: it distinguishes
   * "no override" from "override to the github.com default").
   */
  readonly octokit: (override?: { baseUrl: string | undefined }) => Octokit;
}

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  Effect.Effect<GitHubCredentialsService>
>()("GitHub::Credentials") {}

const make = (
  token: Redacted.Redacted<string>,
  baseUrl?: string,
): GitHubCredentialsService => ({
  token,
  baseUrl,
  octokit: (override) => {
    const url = override !== undefined ? override.baseUrl : baseUrl;
    return new Octokit({
      auth: Redacted.value(token),
      ...(url !== undefined ? { baseUrl: url } : {}),
    });
  },
});

/**
 * Build a `GitHubCredentials` layer from a literal token. Useful for
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
    GitHubCredentials,
    Effect.gen(function* () {
      const baseUrl =
        options?.baseUrl !== undefined
          ? yield* normalizeGitHubBaseUrl(options.baseUrl)
          : undefined;
      return make(
        typeof token === "string" ? Redacted.make(token) : token,
        baseUrl,
      );
    }).pipe(Effect.orDie),
  );

/**
 * Build a `GitHubCredentials` layer that reads the token from
 * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` at layer build time.
 *
 * GitHub Enterprise is resolved from the environment too: `GITHUB_BASE_URL`,
 * `GITHUB_API_URL` (set by GitHub Actions runners), or `GH_HOST` select the
 * host, and on an enterprise host `GH_ENTERPRISE_TOKEN` /
 * `GITHUB_ENTERPRISE_TOKEN` are checked before the standard token variables.
 */
export const fromEnv = () =>
  Layer.succeed(
    GitHubCredentials,
    readEnvCredentials().pipe(
      Effect.map((creds) => make(creds.token, creds.baseUrl)),
      Effect.orDie,
    ),
  );

/**
 * Build a `GitHubCredentials` layer that resolves a token via the
 * Alchemy AuthProvider for the configured profile (defaults to
 * `default`, overridable with `ALCHEMY_PROFILE`).
 *
 * Pass `baseUrl` to hard-code the GitHub host — it takes precedence over
 * whatever host the auth provider resolved from the profile config or
 * environment. `GitHub.providers({ baseUrl })` threads its option here.
 */
export const fromAuthProvider = (options?: { readonly baseUrl?: string }) =>
  Layer.effect(
    GitHubCredentials,
    Effect.gen(function* () {
      const fixedBaseUrl =
        options?.baseUrl !== undefined
          ? { baseUrl: yield* normalizeGitHubBaseUrl(options.baseUrl) }
          : undefined;
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        GitHubAuthConfig,
        GitHubResolvedCredentials
      >(GITHUB_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as GitHubAuthConfig),
        ),
        Effect.map((creds) =>
          make(
            creds.token,
            fixedBaseUrl !== undefined ? fixedBaseUrl.baseUrl : creds.baseUrl,
          ),
        ),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to resolve GitHub credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }).pipe(Effect.orDie),
  );
