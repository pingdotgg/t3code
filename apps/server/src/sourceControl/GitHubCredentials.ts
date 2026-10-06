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

import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `gh auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  /** A digest of host and token: safe for cache keys and rate-limit scopes, never the token. */
  readonly fingerprint: string;
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

/** `gh` is installed but holds no login for the host. */
export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`;
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
  | GitHubCliFailedError;

/**
 * Where GitHub tokens come from. Callers ask per host and never see how the token was found,
 * so another source (an in-app OAuth login) slots in here without touching any of them.
 */
export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops the held token after GitHub refused it, so the next read asks its source again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("t3/sourceControl/GitHubCredentials") {}

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
  const process = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;

  /** `host:sha256(token)`, safe for cache keys and rate-limit scopes. */
  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      // Hashing a string in memory has no platform failure worth a typed error.
      Effect.orDie,
    );

  const fromGh = (host: string) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: ["auth", "token", "--hostname", host],
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
              ? new GitHubNotSignedInError({ host })
              : new GitHubCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host }),
        ),
      );

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (host: string) {
    const fromEnv = environmentToken(host, environment);
    const token = fromEnv ?? (yield* fromGh(host));
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

  return GitHubCredentials.of({
    get: (host) => Cache.get(cache, normalizeHost(host)),
    invalidate: (host) => Cache.invalidate(cache, normalizeHost(host)),
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
