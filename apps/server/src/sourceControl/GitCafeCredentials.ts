import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/** How long a token is reused before `cafe` is asked again, so a re-login applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `cafe auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);

export interface GitCafeCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: "env" | "cafe";
}

/** No `CAFE_TOKEN` for the host, and no `cafe` on PATH to ask. */
export class GitCafeCliMissingError extends Schema.TaggedError<GitCafeCliMissingError>()(
  "GitCafeCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitCafe credential for ${this.host}: set CAFE_TOKEN, or install the GitCafe CLI and run \`cafe auth login\`.`;
  }
}

/** `cafe` is installed but holds no login for the host. */
export class GitCafeNotSignedInError extends Schema.TaggedError<GitCafeNotSignedInError>()(
  "GitCafeNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitCafe credential for ${this.host}: run \`cafe auth login --host https://${this.host}/api\`.`;
  }
}

/** `cafe` timed out or failed for a reason other than having no login. */
export class GitCafeCliFailedError extends Schema.TaggedError<GitCafeCliFailedError>()(
  "GitCafeCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitCafe CLI could not hand over a credential for ${this.host}. Check \`cafe auth status\` on the server.`;
  }
}

export type GitCafeCredentialUnavailableError =
  | GitCafeCliMissingError
  | GitCafeNotSignedInError
  | GitCafeCliFailedError;

/**
 * Where GitCafe tokens come from. Callers ask per host and never see how the token was found,
 * the same split `GitHubCredentials` keeps for `gh`.
 */
export class GitCafeCredentials extends Context.Service<
  GitCafeCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<GitCafeCredential, GitCafeCredentialUnavailableError>;
    /** Drops the held token after GitCafe refused it, so the next read asks its source again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("t3/sourceControl/GitCafeCredentials") {}

/**
 * `CAFE_TOKEN`, but only for the host `cafe` itself would send it to (`CAFE_HOST`, git.cafe by
 * default): a remote URL picks the host, and must not steer a production token to staging.
 */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = env.CAFE_HOST?.trim();
  const configuredHost = configured
    ? URL.parse(configured.includes("://") ? configured : `https://${configured}`)?.host
    : "git.cafe";
  if (configuredHost?.toLowerCase() !== host) return null;
  return env.CAFE_TOKEN?.trim() || null;
}

/** A Git credential `get` answer: `key=value` lines, of which only `password` matters here. */
function credentialPassword(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("password=")) return line.slice("password=".length).trim() || null;
  }
  return null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;

  /**
   * `cafe` has no `auth token` command; its Git credential helper is the supported way to hand
   * the stored login to another program, and answers over stdin/stdout so the token never
   * reaches an argument list or a log.
   */
  const fromCafe = (host: string) =>
    process
      .run({
        operation: "GitCafeCredentials.get",
        command: "cafe",
        args: ["auth", "http", "credential", "--host", `https://${host}/api`, "get"],
        cwd: workingDirectory,
        stdin: `protocol=https\nhost=${host}\n\n`,
        env: { CAFE_NO_UPDATE_CHECK: "1" },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitCafeCliMissingError({ host })
            : error._tag === "VcsProcessExitError"
              ? new GitCafeNotSignedInError({ host })
              : new GitCafeCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => credentialPassword(output.stdout)),
        Effect.filterOrFail(
          (token): token is string => token !== null,
          () => new GitCafeNotSignedInError({ host }),
        ),
      );

  const lookup = Effect.fn("GitCafeCredentials.lookup")(function* (host: string) {
    const fromEnv = environmentToken(host, environment);
    const token = fromEnv ?? (yield* fromCafe(host));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv !== null ? "env" : "cafe",
    } satisfies GitCafeCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 4,
    // A transient failure (a timeout, a locked keyring) is asked again on the next read.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GitCafeCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return GitCafeCredentials.of({
    get: (host) => Cache.get(cache, host.trim().toLowerCase()),
    invalidate: (host) => Cache.invalidate(cache, host.trim().toLowerCase()),
  });
});

export const layer = Layer.effect(GitCafeCredentials, make);
