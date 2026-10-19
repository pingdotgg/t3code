/**
 * The `brnch` CLI, which every Brnch operation goes through: it holds and refreshes the login,
 * and resolves the `owner/name` a remote names to the repository id Brnch's API takes.
 *
 * @module source-control-brnch/server/brnchCli
 */
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, type SourceControlProviderAuth } from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlAuthProbeInput,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/** Brnch has no self-hosted installs. */
export const BRNCH_HOST = "brnch.io";

/**
 * Pinned to brnch.io, so a `BRNCH_URL` aimed elsewhere never receives a request for a repository
 * whose remote names brnch.io. `--json` answers with one document on stdout, failures included.
 */
export const GLOBAL_ARGS = ["--url", `https://${BRNCH_HOST}`, "--json"] as const;

/**
 * The server acts for the person, not as a coding agent, even when it was started from one: an
 * agent marker inherited from that terminal would otherwise send writes through an agent session.
 */
const CLI_ENV = { BRNCH_AGENT: "none", BRNCH_NO_UPDATE_CHECK: "1" };

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^?#]+)/iu,
  /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^[^@/:]+@([^/:]+):(.+)$/u,
];

/** An `owner/name` repository path, without the `.git` suffix a clone URL carries. */
export function brnchRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

/**
 * The `owner/name` of a brnch.io remote or web URL, or null for anything else. HTTPS clones live
 * below `/git/`; the web page and SSH name the repository directly.
 */
export function parseBrnchRemote(url: string): string | null {
  const trimmed = url.trim();
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    if (match[1].toLowerCase() !== BRNCH_HOST) return null;
    const path = /^https?:/iu.test(trimmed)
      ? match[2].replace(/^git\/(?=[^/]+\/[^/]+$)/u, "")
      : match[2];
    return brnchRepositoryPath(path);
  }
  return null;
}

export const BrnchCliFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class BrnchCliError extends Schema.TaggedError<BrnchCliError>()("BrnchCliError", {
  operation: Schema.String,
  reason: BrnchCliFailure,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `brnch ${this.operation} failed: ${this.detail}`;
  }
}

const CliFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.Finite)),
  exit_code: Schema.optional(Schema.Finite),
});
type CliFailure = typeof CliFailure.Type;
/** The CLI's failure document, e.g. `{"error":{"code":"NOT_FOUND","exit_code":4,...}}`. */
const decodeFailure = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ error: CliFailure })),
);

const cliFailure = (stdout: string): CliFailure | undefined => {
  const decoded = decodeFailure(stdout.trim());
  return Result.isSuccess(decoded) ? decoded.success.error : undefined;
};

/** Exit codes from `brnch`'s README: 3 unauthenticated, 4 not found. */
const reasonFor = (failure: CliFailure): typeof BrnchCliFailure.Type =>
  failure.exit_code === 3 || failure.status === 401
    ? "unauthenticated"
    : failure.status === 429
      ? "rate-limited"
      : failure.exit_code === 4 || failure.status === 404
        ? "not-found"
        : "failed";

export const INSTALL_HINT =
  "Install the Brnch CLI with `npm install -g brnch-cli`, then run `brnch auth login`.";

export interface BrnchRunInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  /** Exit codes that still answer with the command's result, such as 7 for a blocked merge. */
  readonly resultExitCodes?: ReadonlyArray<number>;
}

/** @public Construction is part of the module API; each provider builds its own runner. */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  const run = Effect.fn("BrnchCli.run")(function* <A>(
    input: BrnchRunInput,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const fail = (reason: typeof BrnchCliFailure.Type, detail: string, cause?: unknown) =>
      new BrnchCliError({
        operation: input.operation,
        reason,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const output = yield* process
      .run({
        operation: `BrnchCli.${input.operation}`,
        command: "brnch",
        cwd: input.cwd,
        args: [...GLOBAL_ARGS, ...input.args],
        env: CLI_ENV,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? fail("missing-tool", INSTALL_HINT, error)
            : fail("failed", "The Brnch CLI could not be run.", error),
        ),
      );
    if (output.exitCode !== 0 && !input.resultExitCodes?.includes(output.exitCode)) {
      const failure = cliFailure(output.stdout);
      return yield* failure
        ? fail(reasonFor(failure), failure.message)
        : fail("failed", `The Brnch CLI exited with code ${output.exitCode}.`);
    }
    const decoded = Schema.decodeResult(Schema.fromJsonString(schema))(output.stdout);
    return Result.isSuccess(decoded)
      ? decoded.success
      : yield* fail("failed", "The Brnch CLI returned an unreadable response.", decoded.failure);
  });

  return { run };
});

const decodeAuthStatus = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      user: Schema.NullOr(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          handle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
        }),
      ),
    }),
  ),
);

/** `brnch auth status --json`, read as the account repositories are published under. */
export function parseAuthStatus(input: SourceControlAuthProbeInput): SourceControlProviderAuth {
  const status = decodeAuthStatus(input.stdout.trim());
  const user = Result.isSuccess(status) ? status.success.user : null;
  if (input.exitCode === 0 && user)
    return providerAuth({
      status: "authenticated",
      host: BRNCH_HOST,
      account: user.handle ?? user.id,
    });
  const failure = cliFailure(input.stdout);
  if (failure)
    return providerAuth({
      // Only a refusal says the login is gone; an offline or failing answer says nothing.
      status: reasonFor(failure) === "unauthenticated" ? "unauthenticated" : "unknown",
      host: BRNCH_HOST,
      detail: failure.message,
    });
  return providerAuth({
    status: "unknown",
    host: BRNCH_HOST,
    detail: "Brnch authentication status could not be read. Run `brnch auth status`.",
  });
}
