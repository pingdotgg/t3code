/**
 * fork: f4 — the single git runner every working-copy operation goes through.
 *
 * Built on `VcsDriver.execute` (no `VcsDriver.ts` edit, no shell), so output
 * caps, timeouts and the `VcsError` taxonomy are inherited rather than
 * rebuilt.
 *
 * Two behaviours upstream's `runGit` helpers do not give us and the panel
 * needs:
 *
 * - **Full stderr on failure.** `VcsProcessExitError.fromProcessExit` replaces
 *   stderr with a canned `detail` string, but the panel's contract is a toast
 *   carrying the untruncated stderr. Every call therefore runs with
 *   `allowNonZeroExit` and builds the error itself.
 * - **`index.lock` contention retry.** An agent committing in a t3 terminal
 *   holds the lock for a few hundred milliseconds; failing the user's stage on
 *   that is not acceptable.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  VcsProcessExitError,
  WorkingCopyIndexLockedError,
  type WorkingCopyError,
} from "@t3tools/contracts";
import type * as VcsDriver from "../VcsDriver.ts";
import type * as VcsProcess from "../VcsProcess.ts";

/** Matches 2code's 8 MiB ceiling; a diff bigger than this is not reviewable anyway. */
export const WORKING_COPY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const WORKING_COPY_DEFAULT_TIMEOUT_MS = 30_000;

export const INDEX_LOCK_MAX_ATTEMPTS = 4;
export const INDEX_LOCK_BACKOFF_MS = 200;

const INDEX_LOCK_MARKER = /index\.lock/i;

export interface WorkingCopyGitRunInput {
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  /** Enables the `index.lock` contention retry. Reads never retry. */
  readonly mutating?: boolean | undefined;
}

export interface WorkingCopyGit {
  /** The resolved repository root. Every pathspec is relative to it. */
  readonly cwd: string;
  /** Never fails on a non-zero exit — the caller inspects `exitCode`. */
  readonly run: (
    input: WorkingCopyGitRunInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, WorkingCopyError>;
  /** Fails with a `VcsProcessExitError` whose `detail` is the full stderr. */
  readonly ok: (
    input: WorkingCopyGitRunInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, WorkingCopyError>;
}

export function isIndexLockFailure(output: VcsProcess.VcsProcessOutput): boolean {
  return output.exitCode !== 0 && INDEX_LOCK_MARKER.test(output.stderr);
}

export function exitError(
  input: WorkingCopyGitRunInput,
  cwd: string,
  output: VcsProcess.VcsProcessOutput,
): VcsProcessExitError {
  const stderr = output.stderr.trim();
  return new VcsProcessExitError({
    operation: input.operation,
    command: "git",
    cwd,
    argumentCount: input.args.length,
    exitCode: output.exitCode,
    detail: stderr.length > 0 ? stderr : "Process exited with a non-zero status.",
    failureKind: "command-failed",
    stderrLength: output.stderr.length,
    stderrTruncated: output.stderrTruncated,
  });
}

/** Only `execute` is needed, so a test can pass a bare object instead of a driver. */
export type WorkingCopyExecutor = Pick<VcsDriver.VcsDriver["Service"], "execute">;

export function makeWorkingCopyGit(driver: WorkingCopyExecutor, cwd: string): WorkingCopyGit {
  const execute = Effect.fn("WorkingCopyGit.execute")(function* (input: WorkingCopyGitRunInput) {
    return yield* driver.execute({
      operation: input.operation,
      cwd,
      args: input.args,
      allowNonZeroExit: true,
      timeoutMs: input.timeoutMs ?? WORKING_COPY_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? WORKING_COPY_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  });

  /**
   * Retries only while the failure is `index.lock` contention. Any other
   * non-zero exit is returned on the first attempt so the caller sees the real
   * stderr immediately.
   */
  const run: WorkingCopyGit["run"] = Effect.fn("WorkingCopyGit.run")(function* (input) {
    if (input.mutating !== true) {
      return yield* execute(input);
    }
    let attempt = 1;
    while (true) {
      const output = yield* execute(input);
      if (!isIndexLockFailure(output)) {
        return output;
      }
      if (attempt >= INDEX_LOCK_MAX_ATTEMPTS) {
        return yield* new WorkingCopyIndexLockedError({
          operation: input.operation,
          cwd,
          attempts: attempt,
        });
      }
      yield* Effect.sleep(Duration.millis(INDEX_LOCK_BACKOFF_MS * attempt));
      attempt += 1;
    }
  });

  const ok: WorkingCopyGit["ok"] = Effect.fn("WorkingCopyGit.ok")(function* (input) {
    const output = yield* run(input);
    if (output.exitCode !== 0) {
      return yield* exitError(input, cwd, output);
    }
    return output;
  });

  return { cwd, run, ok };
}
