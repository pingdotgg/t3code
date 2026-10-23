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

/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `gh auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["settings", "env", "gh", "git"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  /** A digest of host and token: safe for cache keys and rate-limit scopes, never the token. */
  readonly fingerprint: string;
  /** Git helpers select a credential for this repository, never for the host generally. */
  readonly repository?: string;
}

export class GitHubGitCredentialError extends Schema.TaggedError<GitHubGitCredentialError>()(
  "GitHubGitCredentialError",
  { host: Schema.String, reason: Schema.Literals(["repository", "process", "response"]) },
) {
  override get message(): string {
    return "Git could not safely resolve a repository credential. Check the server's global Git credential helpers.";
  }
}

const Repository = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i),
);
const isRepository = Schema.is(Repository);
/** Canonical HTTPS credential path; never let a selector add credential protocol fields. */
export function normalizeCredentialRepository(repository: string): string | null {
  const normalized = repository.replace(/\.git$/i, "").toLowerCase();
  return isRepository(normalized) &&
    !normalized.split("/").some((part) => part === "." || part === ".." || part.startsWith("-"))
    ? normalized
    : null;
}

/** Nothing in the environment, and no `gh` on PATH to ask. */
export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }
}

/** `gh` is installed but holds no login for the host, or not the account chosen in Settings. */
export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`
      : `No GitHub credential for ${this.account} on ${this.host}: run \`gh auth login --hostname ${this.host}\` for that account or pick another in Settings → Source Control.`;
  }
}

/** The user turned the host off in Settings. */
export class GitHubHostDisabledError extends Schema.TaggedError<GitHubHostDisabledError>()(
  "GitHubHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `GitHub host ${this.host} is turned off in Settings → Source Control.`;
  }
}

/** `gh auth token` timed out or failed for a reason other than having no login. */
export class GitHubCliFailedError extends Schema.TaggedError<GitHubCliFailedError>()(
  "GitHubCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitHub CLI could not hand over a credential for ${this.host}. Check \`gh auth status\` on the server.`;
  }
}

/** There is no token for the host. */
export type GitHubCredentialUnavailableError =
  | GitHubCliMissingError
  | GitHubNotSignedInError
  | GitHubHostDisabledError
  | GitHubCliFailedError
  | GitHubGitCredentialError;

/**
 * Where GitHub tokens come from. Callers ask per host and never see how the token was found,
 * so another source (an in-app OAuth login) slots in here without touching any of them.
 */
export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
      repository?: string,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops the held token after GitHub refused it, so the next read asks its source again. */
    readonly invalidate: (host: string, repository?: string) => Effect.Effect<void>;
    readonly checkEnabled?: (host: string) => Effect.Effect<void, GitHubHostDisabledError>;
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
  const fromGit = Effect.fnUntraced(function* (repository: string) {
    const host = "github.com";
    const normalized = repository.toLowerCase();
    const invalid = () => new GitHubGitCredentialError({ host, reason: "response" });
    const output = yield* process
      .run({
        operation: "GitHubCredentials.git",
        command: "git",
        args: ["-c", "credential.interactive=false", "credential", "fill"],
        // Ignore any repository around the server working directory, including inherited Git
        // selectors. Helpers come only from the server's system/global configuration.
        cwd: workingDirectory,
        stdin: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
        env: {
          GIT_DIR: "",
          GIT_WORK_TREE: "",
          GIT_COMMON_DIR: "",
          GIT_CONFIG: "",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GCM_INTERACTIVE: "never",
          GIT_TRACE: "0",
          GIT_TRACE_SETUP: "0",
          GIT_TRACE_CURL: "0",
          GIT_CURL_VERBOSE: "0",
          GIT_TRACE2: "0",
          GIT_TRACE2_EVENT: "0",
          GIT_TRACE2_PERF: "0",
        },
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
        outputMode: "error",
      })
      .pipe(
        // Neither helper stderr nor lower-level errors may retain credential material.
        Effect.mapError(() => new GitHubGitCredentialError({ host, reason: "process" })),
      );
    if (
      output.stdoutTruncated ||
      output.stderrTruncated ||
      output.stdoutInvalidUtf8 ||
      output.stderrInvalidUtf8
    )
      return yield* invalid();
    if (output.exitCode !== 0) {
      // With prompts disabled, Git's specific missing-credential exit is a normal miss. Any
      // helper error before it makes this an operational failure, rather than a fallback.
      const missing = output.stderr.match(
        /^(?:fatal: could not read (?:Username|Password) for '[^'\r\n]*': terminal prompts disabled|fatal: unable to get password from user)(?:\r?\n)?$/,
      );
      if (output.stdout === "" && missing?.[0] === output.stderr) return null;
      return yield* new GitHubGitCredentialError({ host, reason: "process" });
    }
    if (output.stderr !== "")
      return yield* new GitHubGitCredentialError({ host, reason: "process" });
    if (output.stdout === "") return null;
    if (!output.stdout.endsWith("\n") || /[\0\r]/.test(output.stdout)) return yield* invalid();
    const fields = new Map<string, string>();
    let ended = false;
    for (const line of output.stdout.split("\n").slice(0, -1)) {
      if (line === "") {
        ended = true;
        continue;
      }
      const equals = line.indexOf("=");
      if (ended || equals <= 0) return yield* invalid();
      const key = line.slice(0, equals);
      if (fields.has(key)) return yield* invalid();
      fields.set(key, line.slice(equals + 1));
    }
    // `useHttpPath=false` owner-specific helpers legitimately erase path after selection.
    const path = fields.get("path");
    if (
      fields.get("protocol") !== "https" ||
      fields.get("host") !== host ||
      (path !== undefined && normalizeCredentialRepository(path) !== normalized)
    )
      return yield* invalid();
    const token = fields.get("password");
    if (!token) return null;
    if (!/^[\x21-\x7e]+$/.test(token)) return yield* invalid();
    return {
      host,
      repository: normalized,
      source: "git",
      token: Redacted.make(token),
      fingerprint: yield* fingerprintOf(host, token),
    } satisfies GitHubCredential;
  });

  /** `host:sha256(token)`, safe for cache keys and rate-limit scopes. */
  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      // Hashing a string in memory has no platform failure worth a typed error.
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

  /** The Settings choice for a host; unreadable settings fall back to gh's own choice. */
  const hostChoice = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => readSettings(settings).hosts[host]),
      Effect.orElseSucceed(() => undefined),
    );

  /** A token saved in Settings for the host, read fresh so a saved or removed one applies at once. */
  const savedToken = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => readSettings(settings).tokens[host]?.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  /** Cache key: the host plus its pinned account, so a changed pin misses the cache. */
  const cacheKey = (host: string, account: string | undefined) =>
    account === undefined ? host : `${host}\u0000${account}`;

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (key: string) {
    const [host = key, choice] = key.split("\u0000");
    // An environment token wins over a pinned account, exactly as it does in gh.
    const fromEnv = environmentToken(host, environment);
    // A pinned login gh no longer holds (logged out, expired) falls back to the active one,
    // which is what discovery reports as the account in use.
    const token =
      fromEnv ??
      (yield* fromGh(host, choice).pipe(
        Effect.catchTags({
          GitHubNotSignedInError: (error) =>
            choice === undefined ? Effect.fail(error) : fromGh(host, undefined),
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
    // A transient gh failure (a timeout, a locked keyring) is asked again on the next read.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GitHubCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  const gitCache = yield* Cache.makeWith(fromGit, {
    capacity: 128,
    timeToLive: (exit) =>
      Exit.isFailure(exit) ? Duration.zero : exit.value === null ? MISSING_TTL : TOKEN_TTL,
  });

  return GitHubCredentials.of({
    checkEnabled: (rawHost) => {
      const host = normalizeHost(rawHost);
      return hostChoice(host).pipe(
        Effect.flatMap((choice) =>
          choice?.enabled === false
            ? Effect.fail(new GitHubHostDisabledError({ host }))
            : Effect.void,
        ),
      );
    },
    get: Effect.fn("GitHubCredentials.get")(function* (rawHost, repository) {
      const host = normalizeHost(rawHost);
      const choice = yield* hostChoice(host);
      if (choice?.enabled === false) {
        return yield* new GitHubHostDisabledError({ host });
      }
      if (
        environment.T3CODE_GITHUB_USE_GIT_CREDENTIALS === "1" &&
        host === "github.com" &&
        repository !== undefined
      ) {
        if (normalizeCredentialRepository(repository) === null)
          return yield* new GitHubGitCredentialError({ host, reason: "repository" });
        const credential = yield* Cache.get(gitCache, repository.replace(/\.git$/i, ""));
        if (credential !== null) return credential;
      }
      // A token saved in Settings is the most deliberate choice, so it comes before the
      // environment and gh. It is read from the secret store each time, so it needs no cache.
      const saved = yield* savedToken(host);
      if (saved !== null) {
        return {
          host,
          token: Redacted.make(saved),
          source: "settings",
          fingerprint: yield* fingerprintOf(host, saved),
        } satisfies GitHubCredential;
      }
      return yield* Cache.get(cache, cacheKey(host, choice?.account));
    }),
    invalidate: (rawHost, repository) => {
      const host = normalizeHost(rawHost);
      const normalized =
        repository === undefined ? null : normalizeCredentialRepository(repository);
      if (
        host === "github.com" &&
        normalized !== null &&
        environment.T3CODE_GITHUB_USE_GIT_CREDENTIALS === "1"
      )
        return Effect.gen(function* () {
          const keys = Array.from(yield* Cache.keys(gitCache));
          // Accept canonical helper provenance and selectors carrying a clone .git suffix.
          const literal = repository?.toLowerCase();
          yield* Effect.forEach(
            keys.filter((key) => key.toLowerCase() === literal || key.toLowerCase() === normalized),
            (key) => Cache.invalidate(gitCache, key),
            { discard: true },
          );
        });
      return hostChoice(host).pipe(
        Effect.flatMap((choice) => Cache.invalidate(cache, cacheKey(host, choice?.account))),
      );
    },
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
