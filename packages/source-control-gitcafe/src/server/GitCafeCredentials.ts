import { settingsSecretLiteral } from "@t3tools/contracts";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import * as GitCafeClient from "../shared/definition.ts";

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);

export interface GitCafeCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: "settings" | "env" | "cafe";
}

export class GitCafeCliMissingError extends Schema.TaggedError<GitCafeCliMissingError>()(
  "GitCafeCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitCafe credential for ${this.host}: set CAFE_TOKEN, or install the GitCafe CLI and run \`cafe auth login\`.`;
  }
}

export class GitCafeNotSignedInError extends Schema.TaggedError<GitCafeNotSignedInError>()(
  "GitCafeNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitCafe credential for ${this.host}: run \`cafe auth login --host https://${this.host}/api\`.`;
  }
}

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

export class GitCafeCredentials extends Context.Service<
  GitCafeCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<GitCafeCredential, GitCafeCredentialUnavailableError>;
    readonly invalidate: (host: string) => Effect.Effect<void>;
    readonly cliEnv: (host: string) => Effect.Effect<Readonly<Record<string, string>>>;
  }
>()("@t3tools/source-control-gitcafe/server/GitCafeCredentials") {}

const DEFAULT_HOST = "git.cafe";

/** Restrict CAFE_TOKEN to CAFE_HOST (default git.cafe), including for staging remotes. */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = env.CAFE_HOST?.trim();
  const configuredHost = configured
    ? URL.parse(configured.includes("://") ? configured : `https://${configured}`)?.host
    : DEFAULT_HOST;
  if (configuredHost?.toLowerCase() !== normalizeHost(host)) return null;
  return env.CAFE_TOKEN?.trim() || null;
}

function credentialPassword(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("password=")) return line.slice("password=".length).trim() || null;
  }
  return null;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const { process } = sourceControlHost;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  /** cafe has no auth-token command; its credential helper keeps tokens out of argv/logs. */
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

  const fromSettings = (host: string) =>
    normalizeHost(host) !== DEFAULT_HOST
      ? Effect.succeed(null)
      : sourceControlHost.settings.get.pipe(
          Effect.map(
            (settings) =>
              settingsSecretLiteral(
                readSourceControlHostSettings(
                  GitCafeClient.settings,
                  settings.sourceControlHosts[GitCafeClient.definition.kind],
                ).token,
              ) || null,
          ),
          Effect.orElseSucceed(() => null),
        );

  const lookup = Effect.fn("GitCafeCredentials.lookup")(function* (
    host: string,
  ): Effect.fn.Return<GitCafeCredential, GitCafeCredentialUnavailableError> {
    const fromEnv = environmentToken(host, environment);
    const token = fromEnv ?? (yield* fromCafe(host));
    return { host, token: Redacted.make(token), source: fromEnv !== null ? "env" : "cafe" };
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 4,
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
    get: Effect.fn("GitCafeCredentials.get")(function (host) {
      return fromSettings(host).pipe(
        Effect.flatMap(
          (saved): Effect.Effect<GitCafeCredential, GitCafeCredentialUnavailableError> =>
            saved === null
              ? Cache.get(cache, normalizeHost(host))
              : Effect.succeed({
                  host: normalizeHost(host),
                  token: Redacted.make(saved),
                  source: "settings",
                }),
        ),
      );
    }),
    invalidate: Effect.fn("GitCafeCredentials.invalidate")(function (host) {
      return Cache.invalidate(cache, normalizeHost(host));
    }),
    cliEnv: Effect.fn("GitCafeCredentials.cliEnv")(function (host) {
      return fromSettings(host).pipe(
        Effect.map((saved) => (saved === null ? {} : { CAFE_TOKEN: saved })),
      );
    }),
  });
});

export const layer = Layer.effect(GitCafeCredentials, make);
