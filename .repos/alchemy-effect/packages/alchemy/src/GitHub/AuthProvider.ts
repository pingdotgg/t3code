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
  | { method: "env" }
  | { method: "stored" }
  | { method: "gh-cli" };

export interface GitHubStoredCredentials {
  type: "pat";
  token: string;
}

export interface GitHubResolvedCredentials {
  type: "token";
  token: Redacted.Redacted<string>;
  source: { type: GitHubAuthConfig["method"]; details?: string };
}

export const GITHUB_AUTH_PROVIDER_NAME = "GitHub";

class GhCliError extends Error {
  readonly _tag = "GhCliError";
}

/**
 * Layer that registers the GitHub {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the GitHub
 * `providers()` layer so `alchemy login` can discover it.
 *
 * Supported methods:
 * - `gh-cli`: shells out to `gh auth token` (recommended).
 * - `env`: reads `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN`.
 * - `stored`: prompts for a PAT and writes it to `~/.alchemy/credentials`.
 *
 * Browser/device OAuth is intentionally not implemented: GitHub's
 * OAuth App flow requires a `client_secret` we cannot ship, and
 * device flow is exactly what `gh auth login` already does.
 */
export const GitHubAuth = AuthProviderLayer<
  GitHubAuthConfig,
  GitHubResolvedCredentials
>()(
  GITHUB_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const cp = yield* ChildProcessSpawner;

    const ghCliToken = (): Effect.Effect<string, AuthError> =>
      Effect.gen(function* () {
        const handle = yield* cp.spawn(
          ChildProcess.make("gh", ["auth", "token"], { shell: false }),
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

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
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
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "GitHub authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("gh-cli", () =>
              ghCliToken().pipe(
                Effect.as({ method: "gh-cli" as const }),
                Effect.mapError(
                  (e) =>
                    new AuthError({
                      message: `gh CLI not available: ${e.message}`,
                      cause: e,
                    }),
                ),
              ),
            ),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
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
        Match.when(
          { method: "env" },
          Effect.fnUntraced(function* () {
            const access = yield* getEnvRedacted("GITHUB_ACCESS_TOKEN");
            if (access) {
              return {
                type: "token" as const,
                token: access,
                source: {
                  type: "env" as const,
                  details: "GITHUB_ACCESS_TOKEN",
                },
              };
            }
            const token = yield* getEnvRedacted("GITHUB_TOKEN");
            if (token) {
              return {
                type: "token" as const,
                token,
                source: { type: "env" as const, details: "GITHUB_TOKEN" },
              };
            }
            return yield* new AuthError({
              message:
                "GitHub env credentials not found. Set GITHUB_ACCESS_TOKEN or GITHUB_TOKEN.",
            });
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<GitHubStoredCredentials>(profileName, "gh-stored").pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "GitHub stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : Effect.succeed({
                    type: "token" as const,
                    token: Redacted.make(creds.token),
                    source: { type: "stored" as const },
                  }),
            ),
          ),
        ),
        Match.when({ method: "gh-cli" }, () =>
          ghCliToken().pipe(
            Effect.map((token) => ({
              type: "token" as const,
              token: Redacted.make(token),
              source: { type: "gh-cli" as const },
            })),
          ),
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
          Match.when({ method: "gh-cli" }, () =>
            ghCliToken().pipe(
              Effect.tap(() =>
                Clank.success("GitHub: gh CLI authentication available."),
              ),
              Effect.asVoid,
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<GitHubStoredCredentials>(profileName, "gh-stored")
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
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
          ]);
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
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
