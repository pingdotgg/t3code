import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import {
  type VcsError,
  type VcsProcessErrorContext,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: ProcessRunner.ProcessRunInput["outputMode"];
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/VcsProcess") {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const VCS_PROCESS_CONCURRENCY = 8;
const GITHUB_PROCESS_CONCURRENCY = 4;

/** Shown to users when a Git command fails because another process holds the index lock. */
export const GIT_INDEX_LOCKED_DETAIL =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";

export const CHECKPOINT_CAPTURE_OPERATION = "GitVcsDriver.checkpoints.captureCheckpoint";

/**
 * Appends `key=value` to the `GIT_CONFIG_*` entries git reads as command-line
 * config, so argv stays the same on every platform and nothing is written to
 * the user's config. The entry goes after any inherited ones. Windows env names
 * are case-insensitive (elsewhere git reads only `GIT_CONFIG_COUNT`), so there the
 * count is found regardless of casing, read from
 * the last spelling (a per-command value spread over process.env), and updated
 * under every spelling so the child sees it whichever one Node keeps. A count
 * git would reject is left alone so git still reports it.
 */
export const gitConfigEnv = (
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const countKeys = Object.keys(env).filter((name) =>
    platform === "win32" ? name.toUpperCase() === "GIT_CONFIG_COUNT" : name === "GIT_CONFIG_COUNT",
  );
  const countKey = countKeys.at(-1) ?? "GIT_CONFIG_COUNT";
  const inherited = env[countKey];
  if (
    inherited !== undefined &&
    inherited !== "" &&
    // Git parses the count with strtoul: leading whitespace, an optional sign
    // (only -0 is non-negative), digits, and nothing after them.
    /^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(inherited)?.[0] !== inherited
  ) {
    return {};
  }
  const count = inherited === undefined || inherited === "" ? 0 : Number.parseInt(inherited, 10);
  return {
    ...Object.fromEntries([...countKeys, countKey].map((name) => [name, String(count + 1)])),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
};

/**
 * Git otherwise opens any folder holding `HEAD`, `objects/` and `refs/` as a
 * bare repository and applies its `config`, including commands such as
 * `core.fsmonitor`. Files saved in a project or checked out from a clone can
 * form one, so git started by T3 (or by gh and friends) only opens a bare
 * repository named with `--git-dir` or `GIT_DIR`. Git before 2.38 ignores it.
 */
export const explicitBareRepositoryEnv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  gitConfigEnv(env, "safe.bareRepository", "explicit", platform);

const classifyNonZeroExit = (command: string, stderr: string): VcsProcessExitFailureKind => {
  const normalized = stderr.toLowerCase();

  if (
    normalized.includes("authentication failed") ||
    (command === "az" && normalized.includes("requires user authentication")) ||
    normalized.includes("not logged in") ||
    normalized.includes("gh auth login") ||
    normalized.includes("glab auth login") ||
    normalized.includes("az devops login") ||
    normalized.includes("please run az login") ||
    normalized.includes("no oauth token") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    normalized.includes("api rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429")
  ) {
    return "rate-limited";
  }

  if (
    (command === "gh" &&
      (normalized.includes("could not resolve to a pullrequest") ||
        normalized.includes("repository.pullrequest") ||
        normalized.includes("no pull requests found for branch") ||
        normalized.includes("pull request not found"))) ||
    (command === "glab" &&
      (normalized.includes("merge request not found") ||
        normalized.includes("not found") ||
        normalized.includes("404"))) ||
    (command === "az" &&
      normalized.includes("pull request") &&
      (normalized.includes("not found") || normalized.includes("does not exist")))
  ) {
    return "not-found";
  }

  return "command-failed";
};

// Classify before discarding stderr; keep paths and process output out of errors.
const isTransientGitExit = (stderr: string) =>
  /unable to create [^\n]*\.lock['"]?: file exists/i.test(stderr) ||
  /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(stderr);

// On macOS, Git's fsync uses F_FULLFSYNC; writeout-only still uses fsync(2).
// Network mounts can reject F_FULLFSYNC. Ref writes omit errno, so retry their
// bare write error too; explicit unrelated errors remain failures.
// Linux writeout-only only starts writeback, so it must not use this fallback.
const FULL_FSYNC_ARG = "core.fsyncMethod=fsync";
const BATCH_FSYNC_ARG = "core.fsyncMethod=batch";
const WRITEOUT_ONLY_FSYNC_ARG = "core.fsyncMethod=writeout-only";
const canRetryFullFsync = (stderr: string) =>
  /fsync error on [^\r\n]+: operation not supported\r?$/im.test(stderr) ||
  /cannot update ref [^\r\n]+: couldn't write '[^\r\n]+\.lock'\r?$/im.test(stderr);

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcess.Platform;
  const vcsProcesses = yield* Semaphore.make(VCS_PROCESS_CONCURRENCY);
  const githubProcesses = yield* Semaphore.make(GITHUB_PROCESS_CONCURRENCY);

  const spawn = (input: VcsProcessInput, baseError: VcsProcessErrorContext) =>
    processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
        env: {
          ...input.env,
          ...explicitBareRepositoryEnv({ ...process.env, ...input.env }, hostPlatform),
        },
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: input.outputMode ?? "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      );

  const runUnbounded = Effect.fn("VcsProcess.runUnbounded")(function* (input: VcsProcessInput) {
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    };

    let result = yield* spawn(input, baseError);

    if (
      hostPlatform === "darwin" &&
      input.operation === CHECKPOINT_CAPTURE_OPERATION &&
      !input.allowNonZeroExit &&
      result.code !== null &&
      result.code !== 0 &&
      input.command === "git" &&
      (input.args.includes(FULL_FSYNC_ARG) || input.args.includes(BATCH_FSYNC_ARG)) &&
      canRetryFullFsync(result.stderr)
    ) {
      result = yield* spawn(
        {
          ...input,
          args: input.args.map((arg) =>
            arg === FULL_FSYNC_ARG || arg === BATCH_FSYNC_ARG ? WRITEOUT_ONLY_FSYNC_ARG : arg,
          ),
        },
        baseError,
      );
    }

    if (result.code === null) {
      return yield* new VcsProcessMissingExitCodeError(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      const failureKind = classifyNonZeroExit(input.command, result.stderr);
      const error = VcsProcessExitError.fromProcessExit(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        failureKind,
        input.command === "git" &&
          failureKind === "command-failed" &&
          isTransientGitExit(result.stderr),
      );
      if (
        input.command === "git" &&
        /^fatal: unable to create ['"][^\r\n]*[/\\]index\.lock['"]: file exists\.?$/im.test(
          result.stderr,
        )
      ) {
        return yield* new VcsProcessExitError({
          ...error,
          detail: GIT_INDEX_LOCKED_DETAIL,
        });
      }
      return yield* error;
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8 ?? false,
      stderrInvalidUtf8: result.stderrInvalidUtf8 ?? false,
    } satisfies VcsProcessOutput;
  });

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const bounded = vcsProcesses.withPermits(1)(runUnbounded(input));
    if (
      input.command === "git" &&
      input.operation === CHECKPOINT_CAPTURE_OPERATION &&
      input.onStdoutChunk === undefined
    ) {
      return yield* bounded.pipe(
        Effect.tapError((error) =>
          Effect.logDebug("checkpoint Git command failed", {
            operation: input.operation,
            errorTag: error._tag,
          }),
        ),
        Effect.retry({
          times: 2,
          while: (error) => error._tag === "VcsProcessExitError" && error.retryable === true,
          schedule: Schedule.spaced(Duration.millis(75)),
        }),
      );
    }
    return yield* input.command === "gh" ? githubProcesses.withPermits(1)(bounded) : bounded;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer));
