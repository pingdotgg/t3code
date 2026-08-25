import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";
import {
  githubHostname,
  normalizeGitHubBaseUrl,
  resolveGitHubBaseUrlFromEnv,
} from "./BaseUrl.ts";

const options: Array<{
  value: GitHubAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "gh-cli",
    label: "GitHub CLI",
    hint: "delegate to `gh auth token` (run `gh auth login` first)",
  },
  {
    value: "env",
    label: "Environment Variables",
    hint: "GITHUB_ACCESS_TOKEN or GITHUB_TOKEN",
  },
  {
    value: "stored",
    label: "Personal Access Token",
    hint: "enter PAT interactively, stored in ~/.alchemy/credentials",
  },
];

export type GitHubAuthConfig =
  | { method: "env"; baseUrl?: string }
  | { method: "stored"; baseUrl?: string }
  | { method: "gh-cli"; baseUrl?: string };

export interface GitHubStoredCredentials {
  type: "pat";
  token: string;
}

export interface GitHubResolvedCredentials {
  type: "token";
  token: Redacted.Redacted<string>;
  /**
   * Normalized REST API base URL for GitHub Enterprise (e.g.
   * `https://github.example.com/api/v3` or `https://api.acme.ghe.com`).
   * `undefined` means github.com.
   */
  baseUrl?: string;
  source: { type: GitHubAuthConfig["method"]; details?: string };
}

export const GITHUB_AUTH_PROVIDER_NAME = "GitHub";

class GhCliError extends Error {
  readonly _tag = "GhCliError";
}

/**
 * Read a token from the environment for the given (already-resolved) base
 * URL. On a GitHub Enterprise host, the gh CLI's enterprise token variables
 * (`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) are checked before the
 * standard `GITHUB_ACCESS_TOKEN` / `GITHUB_TOKEN`.
 */
const readEnvTokenFor = (
  baseUrl: string | undefined,
): Effect.Effect<GitHubResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const candidates =
      baseUrl !== undefined
        ? [
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GITHUB_ACCESS_TOKEN",
            "GITHUB_TOKEN",
          ]
        : ["GITHUB_ACCESS_TOKEN", "GITHUB_TOKEN"];
    for (const key of candidates) {
      const token = yield* getEnvRedacted(key);
      if (token) {
        return {
          type: "token" as const,
          token,
          baseUrl,
          source: { type: "env" as const, details: key },
        };
      }
    }
    return yield* new AuthError({
      message: `GitHub env credentials not found. Set ${candidates.join(", ")}.`,
    });
  });

/**
 * Read GitHub credentials from the environment. The base URL comes from the
 * stored config when set, otherwise from `GITHUB_BASE_URL`, `GITHUB_API_URL`,
 * or `GH_HOST`.
 */
export const readEnvCredentials = (
  configBaseUrl?: string,
): Effect.Effect<GitHubResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const baseUrl = configBaseUrl ?? (yield* resolveGitHubBaseUrlFromEnv);
    return yield* readEnvTokenFor(baseUrl);
  });

/**
 * Build the Layer that registers the GitHub {@link AuthProvider} into the
 * {@link AuthProviders} registry. Included in the GitHub `providers()` layer
 * so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `gh-cli`: shells out to `gh auth token` (recommended).
 * - `env`: reads `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` (plus
 *   `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` on enterprise hosts).
 * - `stored`: prompts for a PAT and writes it to `~/.alchemy/credentials`.
 *
 * GitHub Enterprise (Server or Cloud with data residency) is supported by
 * every method: `alchemy login --configure` prompts for the host, or set
 * `GITHUB_BASE_URL` / `GITHUB_API_URL` / `GH_HOST` in the environment. The
 * host is normalized into the REST API base URL passed to Octokit, and
 * `gh auth token` is invoked with `--hostname` so the CLI returns the token
 * for the right host.
 *
 * Browser/device OAuth is intentionally not implemented: GitHub's
 * OAuth App flow requires a `client_secret` we cannot ship, and
 * device flow is exactly what `gh auth login` already does.
 */
export interface GitHubAuthOptions {
  /**
   * Hard-code the GitHub host or API base URL (e.g. `github.example.com`
   * or `https://github.example.com/api/v3`). When set, it takes precedence
   * over the profile's configured host and the environment for every auth
   * method, `alchemy login` stops prompting for a host, and the `gh` CLI
   * method authenticates against this host. `GitHub.providers({ baseUrl })`
   * threads its option here.
   */
  readonly baseUrl?: string;
}

export const makeGitHubAuth = (authOptions?: GitHubAuthOptions) =>
  AuthProviderLayer<GitHubAuthConfig, GitHubResolvedCredentials>()(
    GITHUB_AUTH_PROVIDER_NAME,
    Effect.gen(function* () {
      const store = yield* CredentialsStore;
      const cp = yield* ChildProcessSpawner;

      // Hard-coded host from `providers({ baseUrl })`, resolved once at layer
      // build. Kept as an object so "no option" (undefined) is distinct from
      // "option normalized to the github.com default" ({ baseUrl: undefined })
      // — both matter: the latter still pins the host and mutes the prompt.
      const fixed =
        authOptions?.baseUrl !== undefined
          ? {
              baseUrl: yield* normalizeGitHubBaseUrl(authOptions.baseUrl).pipe(
                Effect.orDie,
              ),
            }
          : undefined;

      // The host every method authenticates against: the hard-coded value
      // wins, then the profile's configured host, then the environment.
      const effectiveBaseUrl = (
        config: GitHubAuthConfig,
      ): Effect.Effect<string | undefined, AuthError> =>
        fixed !== undefined
          ? Effect.succeed(fixed.baseUrl)
          : config.baseUrl !== undefined
            ? Effect.succeed(config.baseUrl)
            : resolveGitHubBaseUrlFromEnv;

      const ghCliToken = (
        hostname?: string,
      ): Effect.Effect<string, AuthError> =>
        Effect.gen(function* () {
          const handle = yield* cp.spawn(
            ChildProcess.make(
              "gh",
              [
                "auth",
                "token",
                ...(hostname !== undefined ? ["--hostname", hostname] : []),
              ],
              { shell: false },
            ),
          );
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              handle.exitCode,
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
            ],
            { concurrency: 3 },
          );
          if (exitCode !== 0) {
            return yield* Effect.fail(
              new GhCliError(
                `gh auth token exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
              ),
            );
          }
          const token = stdout.trim();
          if (!token) {
            return yield* Effect.fail(
              new GhCliError("gh auth token returned empty output"),
            );
          }
          return token;
        }).pipe(
          Effect.scoped,
          Effect.mapError((e) =>
            e instanceof GhCliError
              ? new AuthError({ message: e.message, cause: e })
              : new AuthError({
                  message:
                    "Could not invoke `gh`. Install GitHub CLI from https://cli.github.com/ and run `gh auth login`.",
                  cause: e,
                }),
          ),
        );

      const loginStored = Effect.fn(function* (
        profileName: string,
        baseUrl?: string,
      ) {
        const token = yield* Clank.password({
          message:
            "GitHub Personal Access Token (needs `repo` scope; `workflow` for Actions)",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        yield* store.write<GitHubStoredCredentials>(profileName, "gh-stored", {
          type: "pat",
          token,
        });
        yield* Clank.success("GitHub: credentials saved.");
        return { method: "stored" as const, baseUrl };
      });

      // Optional GitHub Enterprise host. Blank means github.com; anything else
      // is normalized into the REST API base URL (GHES gets `/api/v3`
      // appended, data-residency hosts get the `api.` prefix).
      const promptBaseUrl = Clank.text({
        message:
          "GitHub host (leave blank for github.com; e.g. github.example.com for GitHub Enterprise)",
        placeholder: "github.com",
        defaultValue: "",
      }).pipe(
        retryOnce,
        Effect.flatMap((input) => {
          const trimmed = (input ?? "").trim();
          return trimmed === ""
            ? Effect.succeed(undefined)
            : normalizeGitHubBaseUrl(trimmed);
        }),
      );

      const configureInteractive = (profileName: string) =>
        Effect.gen(function* () {
          const method = yield* Clank.select({
            message: "GitHub authentication method",
            options,
          });
          // The host prompt is skipped when providers({ baseUrl }) pinned it —
          // nothing is stored in the profile config; `read` re-applies the
          // pinned value from code on every resolution.
          const baseUrl =
            fixed !== undefined ? undefined : yield* promptBaseUrl;
          const verifyHost = fixed !== undefined ? fixed.baseUrl : baseUrl;
          return yield* Match.value(method).pipe(
            Match.when("env", () =>
              Effect.succeed({ method: "env" as const, baseUrl }),
            ),
            Match.when("gh-cli", () =>
              ghCliToken(
                verifyHost !== undefined
                  ? githubHostname(verifyHost)
                  : undefined,
              ).pipe(
                Effect.as({ method: "gh-cli" as const, baseUrl }),
                Effect.mapError(
                  (e) =>
                    new AuthError({
                      message: `gh CLI not available: ${e.message}`,
                      cause: e,
                    }),
                ),
              ),
            ),
            Match.when("stored", () => loginStored(profileName, baseUrl)),
            Match.exhaustive,
          );
        });

      const configureCredentials = (
        profileName: string,
        ctx: ConfigureContext,
      ) =>
        Effect.gen(function* () {
          if (ctx.ci) {
            return { method: "env" as const };
          }
          return yield* configureInteractive(profileName);
        }).pipe(
          Effect.mapError(
            (e) =>
              new AuthError({
                message: "failed to configure credentials",
                cause: e,
              }),
          ),
        );

      const resolveCredentials = (
        profileName: string,
        config: GitHubAuthConfig,
      ): Effect.Effect<GitHubResolvedCredentials, AuthError> =>
        Match.value(config).pipe(
          Match.when({ method: "env" }, (c) =>
            effectiveBaseUrl(c).pipe(Effect.flatMap(readEnvTokenFor)),
          ),
          Match.when(
            { method: "stored" },
            Effect.fn(function* (c) {
              const baseUrl = yield* effectiveBaseUrl(c);
              const creds = yield* store.read<GitHubStoredCredentials>(
                profileName,
                "gh-stored",
              );
              if (creds == null) {
                return yield* new AuthError({
                  message:
                    "GitHub stored credentials not found. Run: alchemy login --configure",
                });
              }
              return {
                type: "token" as const,
                token: Redacted.make(creds.token),
                baseUrl,
                source: { type: "stored" as const },
              };
            }),
          ),
          Match.when(
            { method: "gh-cli" },
            Effect.fn(function* (c) {
              const baseUrl = yield* effectiveBaseUrl(c);
              const token = yield* ghCliToken(
                baseUrl !== undefined ? githubHostname(baseUrl) : undefined,
              );
              return {
                type: "token" as const,
                token: Redacted.make(token),
                baseUrl,
                source: { type: "gh-cli" as const },
              };
            }),
          ),
          Match.exhaustive,
        );

      const logout = (profileName: string, config: GitHubAuthConfig) =>
        Match.value(config).pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "gh-cli" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .delete(profileName, "gh-stored")
              .pipe(
                Effect.andThen(
                  Clank.success("GitHub: stored credentials removed"),
                ),
              ),
          ),
          Match.exhaustive,
        );

      const login = (profileName: string, config: GitHubAuthConfig) =>
        Match.value(config)
          .pipe(
            Match.when({ method: "env" }, () => Effect.void),
            Match.when({ method: "gh-cli" }, (c) =>
              effectiveBaseUrl(c).pipe(
                Effect.flatMap((baseUrl) =>
                  ghCliToken(
                    baseUrl !== undefined ? githubHostname(baseUrl) : undefined,
                  ),
                ),
                Effect.tap(() =>
                  Clank.success("GitHub: gh CLI authentication available."),
                ),
                Effect.asVoid,
              ),
            ),
            Match.when({ method: "stored" }, (c) =>
              store
                .read<GitHubStoredCredentials>(profileName, "gh-stored")
                .pipe(
                  Effect.flatMap((creds) =>
                    creds == null
                      ? loginStored(profileName, c.baseUrl)
                      : Effect.void,
                  ),
                ),
            ),
            Match.exhaustive,
          )
          .pipe(
            Effect.mapError(
              (e) => new AuthError({ message: "login failed", cause: e }),
            ),
          );

      const prettyPrint = (profileName: string, config: GitHubAuthConfig) =>
        resolveCredentials(profileName, config).pipe(
          Effect.tap((creds) => {
            const sourceStr = creds.source.details
              ? `${creds.source.type} - ${creds.source.details}`
              : creds.source.type;
            return Effect.all([
              Console.log(`  token: ${displayRedacted(creds.token, 6)}`),
              Console.log(`  source: ${sourceStr}`),
              ...(creds.baseUrl !== undefined
                ? [Console.log(`  baseUrl: ${creds.baseUrl}`)]
                : []),
            ]);
          }),
        );

      return {
        configure: configureCredentials,
        logout,
        login,
        prettyPrint,
        read: resolveCredentials,
      };
    }),
  );

/**
 * The default GitHub AuthProvider layer — {@link makeGitHubAuth} with no
 * hard-coded host. Use `GitHub.providers({ baseUrl })` (or
 * `makeGitHubAuth({ baseUrl })` directly) to pin a GitHub Enterprise host.
 */
export const GitHubAuth = makeGitHubAuth();
