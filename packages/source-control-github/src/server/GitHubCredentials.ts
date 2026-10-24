import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/client/definition";
import type { ServerSettings } from "@t3tools/contracts";

import * as GitHubClient from "../client/definition.ts";

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["settings", "env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  readonly fingerprint: string;
}

export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }
}

export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`
      : `No GitHub credential for ${this.account} on ${this.host}: run \`gh auth login --hostname ${this.host}\` for that account, or review Settings → Source Control and \`git config github.user\`.`;
  }
}

export class GitHubHostDisabledError extends Schema.TaggedError<GitHubHostDisabledError>()(
  "GitHubHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `GitHub host ${this.host} is turned off in Settings → Source Control.`;
  }
}

export class GitHubCliFailedError extends Schema.TaggedError<GitHubCliFailedError>()(
  "GitHubCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitHub CLI could not hand over a credential for ${this.host}. Check \`gh auth status\` on the server.`;
  }
}

export type GitHubCredentialUnavailableError =
  | GitHubCliMissingError
  | GitHubNotSignedInError
  | GitHubHostDisabledError
  | GitHubCliFailedError
  | GitHubRepositoryAccountError;

/** The account choice could not be read, so another login must not be used. */
export class GitHubRepositoryAccountError extends Schema.TaggedError<GitHubRepositoryAccountError>()(
  "GitHubRepositoryAccountError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `T3 Code cannot read \`git config github.user\` in ${this.cwd}. Run \`git config --get github.user\` in that folder to see the Git error.`;
  }
}

/** The checkout for this request. Host discovery does not select a repository account. */
export const RepositoryDirectory = Context.Reference<string | null>(
  "@t3tools/source-control-github/server/GitHubCredentials/RepositoryDirectory",
  { defaultValue: () => null },
);

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-github/server/GitHubCredentials") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Hosts gh treats as GitHub.com-like for `GH_TOKEN`: github.com and GHE.com data residency. */
function isGitHubDotCom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/**
 * The environment token for a host, in gh's precedence order. gh hands `GH_ENTERPRISE_TOKEN` to
 * any non-github.com host; here it only goes to the host `GH_HOST` names, because a remote URL
 * picks the host and a hostile one must not receive an enterprise token.
 */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const names = isGitHubDotCom(host)
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : env.GH_HOST?.trim().toLowerCase() === host
      ? ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
      : [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  const fromGh = (host: string, account: string | undefined) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          host,
          ...(account === undefined ? [] : ["--user", account]),
        ],
        cwd: workingDirectory,
        // Never let gh print the token into a debug log.
        env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitHubCliMissingError({ host })
            : // gh exits non-zero with "no oauth token" when it has no login for the host.
              error._tag === "VcsProcessExitError"
              ? new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) })
              : new GitHubCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) }),
        ),
      );

  const readSettings = (settings: ServerSettings) =>
    readSourceControlHostSettings(
      GitHubClient.settings,
      settings.sourceControlHosts[GitHubClient.definition.kind],
    );

  const hostChoice = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => readSettings(settings).hosts[host]),
      Effect.orElseSucceed(() => undefined),
    );

  const savedToken = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => readSettings(settings).tokens[host]?.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  /** Cache key: the host plus its pinned account, so a changed pin misses the cache. */
  const cacheKey = (host: string, account: string | undefined, repository = false) =>
    account === undefined ? host : `${host}\u0000${account}${repository ? "\u0000repo" : ""}`;

  const repositoryAccounts = yield* Cache.makeWith(
    (cwd: string) =>
      process
        .run({
          operation: "GitHubCredentials.repositoryAccount",
          command: "git",
          args: ["config", "--get", "github.user"],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.mapError((cause) => new GitHubRepositoryAccountError({ cwd, cause })),
          Effect.flatMap((output) =>
            output.exitCode === 0
              ? Effect.succeed(output.stdout.trim() || undefined)
              : output.exitCode === 1
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new GitHubRepositoryAccountError({
                      cwd,
                      cause: new Error(`Git exited with code ${output.exitCode}.`),
                    }),
                  ),
          ),
        ),
    {
      capacity: 512,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(5) : Duration.zero),
    },
  );

  const repositoryAccount = Effect.fn("GitHubCredentials.repositoryAccount")(function* (
    host: string,
  ) {
    const cwd = yield* RepositoryDirectory;
    if (host !== "github.com" || cwd === null || environmentToken(host, environment) !== null)
      return undefined;
    return yield* Cache.get(repositoryAccounts, cwd);
  });

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (key: string) {
    const [host = key, choice, repository] = key.split("\u0000");
    // An environment token wins over a pinned account, exactly as it does in gh.
    const fromEnv = environmentToken(host, environment);
    // Keep the existing Settings fallback. A repository account must never fall back to another login.
    const token =
      fromEnv ??
      (yield* fromGh(host, choice).pipe(
        Effect.catchTags({
          GitHubNotSignedInError: (error) =>
            choice === undefined || repository === "repo"
              ? Effect.fail(error)
              : fromGh(host, undefined),
        }),
      ));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv !== null ? "env" : "gh",
      fingerprint: yield* fingerprintOf(host, token),
    } satisfies GitHubCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GitHubCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return GitHubCredentials.of({
    get: Effect.fn("GitHubCredentials.get")(function* (rawHost) {
      const host = normalizeHost(rawHost);
      const choice = yield* hostChoice(host);
      if (choice?.enabled === false) {
        return yield* new GitHubHostDisabledError({ host });
      }
      const saved = yield* savedToken(host);
      if (saved !== null) {
        return {
          host,
          token: Redacted.make(saved),
          source: "settings",
          fingerprint: yield* fingerprintOf(host, saved),
        } satisfies GitHubCredential;
      }
      const account = yield* repositoryAccount(host);
      return yield* Cache.get(
        cache,
        cacheKey(host, account ?? choice?.account, account !== undefined),
      );
    }),
    invalidate: Effect.fn("GitHubCredentials.invalidate")(function* (rawHost) {
      const host = normalizeHost(rawHost);
      const choice = yield* hostChoice(host);
      const account = yield* repositoryAccount(host).pipe(Effect.orElseSucceed(() => undefined));
      yield* Cache.invalidate(
        cache,
        cacheKey(host, account ?? choice?.account, account !== undefined),
      );
    }),
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
