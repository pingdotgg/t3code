import * as Effect from "effect/Effect";

import { type VcsError, VcsProcessExitError } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface JjCommandOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
  readonly appendTruncationMarker?: boolean;
  /** Pure reads that must not snapshot the working copy. Adds `--ignore-working-copy`. */
  readonly ignoreWorkingCopy?: boolean;
  /** Extra `--config KEY=VALUE` pairs, applied to this invocation only. */
  readonly config?: ReadonlyArray<readonly [key: string, value: string]>;
}

const STALE_WORKSPACE_MARKERS = ["working copy is stale", "concurrent modification detected"];
const LARGE_FILE_BANNER = "refused to snapshot some files";
const UPDATE_STALE_TIMEOUT_MS = 30_000;
const LOGGED_STDERR_MAX_CHARS = 2_000;

/**
 * A colocated repository imports git refs on every jj command that touches the working copy, so
 * `git.abandon-unreachable-commits` (default true) lets an ordinary status poll abandon commits the
 * user's own `git fetch` or `git branch -f` moved a ref away from, rewriting files on disk. The
 * guard belongs to everything T3 runs on the user's behalf, never to their own jj invocations.
 */
const JJ_GLOBAL_ARGS = [
  "--no-pager",
  "--color=never",
  "--quiet",
  "--config",
  "git.abandon-unreachable-commits=false",
] as const;

function configFlags(config: JjCommandOptions["config"]): string[] {
  return config?.flatMap(([key, value]) => ["--config", `${key}=${value}`]) ?? [];
}

function passthroughOptions(options: JjCommandOptions | undefined) {
  return {
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  };
}

function jjArgs(args: ReadonlyArray<string>, options: JjCommandOptions | undefined): string[] {
  return [
    ...JJ_GLOBAL_ARGS,
    ...configFlags(options?.config),
    ...(options?.ignoreWorkingCopy === true ? ["--ignore-working-copy"] : []),
    ...args,
  ];
}

function isStaleWorkspace(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return STALE_WORKSPACE_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Runs `jj` inside `cwd` (no `-R`: jj's `-R` demands an exact workspace root, and callers pass
 * project subdirectories). Retries once through `jj workspace update-stale` when the workspace is
 * stale. Warnings, hints and the large-file banner land on stderr, so only stdout may be parsed.
 */
export const jjCommand = Effect.fn("JjProcess.jjCommand")(function* (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: JjCommandOptions,
): Effect.fn.Return<VcsProcess.VcsProcessOutput, VcsError> {
  const input = {
    operation,
    command: "jj",
    args: jjArgs(args, options),
    cwd,
    ...passthroughOptions(options),
    allowNonZeroExit: true,
  } satisfies VcsProcess.VcsProcessInput;

  let result = yield* process.run(input);

  if (result.exitCode !== 0 && isStaleWorkspace(result.stderr)) {
    yield* Effect.logWarning("jj workspace is stale, running `jj workspace update-stale`", {
      cwd,
      operation,
    });
    yield* process.run({
      operation: `${operation}.updateStale`,
      command: "jj",
      args: jjArgs(["workspace", "update-stale"], undefined),
      cwd,
      allowNonZeroExit: true,
      timeoutMs: UPDATE_STALE_TIMEOUT_MS,
    });
    result = yield* process.run(input);
  }

  if (result.stderr.toLowerCase().includes(LARGE_FILE_BANNER)) {
    yield* Effect.logWarning("jj refused to snapshot some files", {
      cwd,
      stderr: result.stderr.slice(0, LOGGED_STDERR_MAX_CHARS),
    });
  }

  if (result.exitCode !== 0 && options?.allowNonZeroExit !== true) {
    return yield* VcsProcessExitError.fromProcessExit(
      { operation, command: "jj", cwd, argumentCount: input.args.length },
      {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
      },
      VcsProcess.classifyNonZeroExit("jj", result.stderr),
    );
  }

  return result;
});

/** The `run(operation, cwd, args, options)` shim every jj module binds once against its process. */
export const jjRunner =
  (process: VcsProcess.VcsProcess["Service"]) =>
  (operation: string, cwd: string, args: ReadonlyArray<string>, options?: JjCommandOptions) =>
    jjCommand(process, operation, cwd, args, options);

export interface ColocatedGitInput {
  readonly gitDir: string;
  readonly workTree?: string;
  readonly cwd: string;
}

/**
 * Runs `git` against the colocated object store. The `--git-dir` is always explicit: a secondary jj
 * workspace has no `.git` for git to discover from its cwd. The process is spawned in `cwd` so the
 * relative paths `check-ignore --stdin` reads resolve against the directory being classified.
 */
export const colocatedGitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  input: ColocatedGitInput,
  args: ReadonlyArray<string>,
  options?: Omit<JjCommandOptions, "ignoreWorkingCopy" | "config">,
): Effect.Effect<VcsProcess.VcsProcessOutput, VcsError> =>
  process.run({
    operation,
    command: "git",
    args: [
      "--git-dir",
      input.gitDir,
      ...(input.workTree !== undefined ? ["--work-tree", input.workTree] : []),
      ...args,
    ],
    cwd: input.cwd,
    ...passthroughOptions(options),
  });
