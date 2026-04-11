import {
  Cache,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, type GitBranch } from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import { compactTraceAttributes } from "../../observability/Attributes.ts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import {
  GitCore,
  type ExecuteGitProgress,
  type GitCommitOptions,
  type GitCoreShape,
  type GitStatusDetails,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../remoteRefs.ts";
import { ServerConfig } from "../../config.ts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  maxOutputBytes?: number | undefined;
  truncateOutputAtMaxBytes?: boolean | undefined;
  progress?: ExecuteGitProgress | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function chunkPathsForGitCheckIgnore(relativePaths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function filterBranchesForListQuery(
  branches: ReadonlyArray<GitBranch>,
  query?: string,
): ReadonlyArray<GitBranch> {
  if (!query) {
    return branches;
  }

  const normalizedQuery = query.toLowerCase();
  return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  branches: ReadonlyArray<GitBranch>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  branches: ReadonlyArray<GitBranch>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.branches.length;
  const branches = input.branches.slice(cursor, cursor + limit);
  const nextCursor = cursor + branches.length < totalCount ? cursor + branches.length : null;

  return {
    branches,
    nextCursor,
    totalCount,
  };
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; upstreamBranch: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    upstreamBranch: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; upstreamBranch: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const upstreamBranch = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || upstreamBranch.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    upstreamBranch,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = (): bigint => BigInt(Date.now()) * 1_000_000n;

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.currentSpan.pipe(
    Effect.tap((span) =>
      Effect.sync(() => {
        span.event(name, nowUnixNano(), compactTraceAttributes(attributes));
      }),
    ),
    Effect.catch(() => Effect.void),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitCore.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.code;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const durationMs = started ? Math.max(0, Date.now() - started.startedAtMs) : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const collectOutput = Effect.fn("collectOutput")(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fn("emitCompleteLines")(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fn("processChunk")(function* (chunk: Uint8Array) {
    if (truncateOutputAtMaxBytes && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!truncateOutputAtMaxBytes && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      truncateOutputAtMaxBytes && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = truncateOutputAtMaxBytes && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.mapError(toGitCommandError(input, "output stream failed.")),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

export const makeGitCore = Effect.fn("makeGitCore")(function* (options?: {
  executeOverride?: GitCoreShape["execute"];
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig;

  let executeRaw: GitCoreShape["execute"];

  if (options?.executeOverride) {
    executeRaw = options.executeOverride;
  } else {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    executeRaw = Effect.fnUntraced(function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const truncateOutputAtMaxBytes = input.truncateOutputAtMaxBytes ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make("git", commandInput.args, {
              cwd: commandInput.cwd,
              env: {
                ...process.env,
                ...input.env,
                ...trace2Monitor.env,
              },
            }),
          )
          .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              truncateOutputAtMaxBytes,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              truncateOutputAtMaxBytes,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(toGitCommandError(commandInput, "failed to write stdin.")),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          const trimmedStderr = stderr.text.trim();
          return yield* new GitCommandError({
            operation: commandInput.operation,
            command: quoteGitCommand(commandInput.args),
            cwd: commandInput.cwd,
            detail:
              trimmedStderr.length > 0
                ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
                : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
          });
        }

        return {
          code: exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ExecuteGitResult;
      });

      return yield* runGitCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  operation: commandInput.operation,
                  command: quoteGitCommand(commandInput.args),
                  cwd: commandInput.cwd,
                  detail: `${quoteGitCommand(commandInput.args)} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    });
  }

  const execute: GitCoreShape["execute"] = (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.code === 0) {
          return Effect.succeed(result);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
        }
        if (options.fallbackErrorMessage) {
          return Effect.fail(
            createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
          );
        }
        return Effect.fail(
          createGitCommandError(
            operation,
            cwd,
            args,
            `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
          ),
        );
      }),
    );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* createGitCommandError(
      "GitCore.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitCore.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchUpstreamRefForStatus = (
    gitCommonDir: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitCore.fetchUpstreamRefForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      {
        allowNonZeroExit: true,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* runGitStdout("GitCore.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
  });

  const refreshStatusUpstreamCacheEntry = Effect.fn("refreshStatusUpstreamCacheEntry")(function* (
    cacheKey: StatusUpstreamRefreshCacheKey,
  ) {
    yield* fetchUpstreamRefForStatus(cacheKey.gitCommonDir, {
      upstreamRef: cacheKey.upstreamRef,
      remoteName: cacheKey.remoteName,
      upstreamBranch: cacheKey.upstreamBranch,
    });
    return true as const;
  });

  const statusUpstreamRefreshCache = yield* Cache.makeWith(refreshStatusUpstreamCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // Keep successful refreshes warm and briefly back off failed refreshes to avoid retry storms.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN,
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusUpstreamRefreshCache,
      new StatusUpstreamRefreshCacheKey({
        gitCommonDir,
        upstreamRef: upstream.upstreamRef,
        remoteName: upstream.remoteName,
        upstreamBranch: upstream.upstreamBranch,
      }),
    );
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitCore.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    branch: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* createGitCommandError(
      "GitCore.resolvePrimaryRemoteName",
      cwd,
      ["remote"],
      "No git remote is configured for this repository.",
    );
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    branch: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitCore.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${branch}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitCore.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  const ensureRemote: GitCoreShape["ensureRemote"] = Effect.fn("ensureRemote")(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout("GitCore.ensureRemote.listRemoteUrls", input.cwd, [
      "remote",
      "-v",
    ]).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
        return remoteName;
      }
    }

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    yield* runGit("GitCore.ensureRemote.add", input.cwd, ["remote", "add", remoteName, input.url]);
    return remoteName;
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    branch: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitCore.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${branch}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
        continue;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    branch: string,
  ) {
    const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
    if (!baseBranch) {
      return 0;
    }

    const result = yield* executeGit(
      "GitCore.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseBranch}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.code !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readBranchRecency = Effect.fn("readBranchRecency")(function* (cwd: string) {
    const branchRecency = yield* executeGit(
      "GitCore.readBranchRecency",
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)",
        "refs/heads",
        "refs/remotes",
      ],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    if (branchRecency.code !== 0) {
      return branchLastCommit;
    }

    for (const line of branchRecency.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
    }

    return branchLastCommit;
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const statusResult = yield* executeGit(
      "GitCore.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.code !== 0) {
      const stderr = statusResult.stderr.trim();
      return yield* createGitCommandError(
        "GitCore.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        stderr || "git status failed",
      );
    }

    const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasOriginRemote] =
      yield* Effect.all(
        [
          runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
          executeGit(
            "GitCore.statusDetails.defaultRef",
            cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              allowNonZeroExit: true,
            },
          ),
          originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
        ],
        { concurrency: "unbounded" },
      );
    const statusStdout = statusResult.stdout;
    const defaultBranch =
      defaultRefResult.code === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }

    if (!upstreamRef && branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(0)),
      );
      behindCount = 0;
    }

    const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
    const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...stagedEntries, ...unstagedEntries]) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote,
      isDefaultBranch:
        branch !== null &&
        (branch === defaultBranch ||
          (defaultBranch === null && (branch === "main" || branch === "master"))),
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    };
  });

  const statusDetailsLocal: GitCoreShape["statusDetailsLocal"] = Effect.fn("statusDetailsLocal")(
    function* (cwd) {
      return yield* readStatusDetailsLocal(cwd);
    },
  );

  const statusDetails: GitCoreShape["statusDetails"] = Effect.fn("statusDetails")(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasOriginRemote: details.hasOriginRemote,
        isDefaultBranch: details.isDefaultBranch,
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    if (filePaths && filePaths.length > 0) {
      yield* runGit("GitCore.prepareCommitContext.reset", cwd, ["reset"]).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* runGit("GitCore.prepareCommitContext.addSelected", cwd, [
        "add",
        "-A",
        "--",
        ...filePaths,
      ]);
    } else {
      yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);
    }

    const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
      "diff",
      "--cached",
      "--name-status",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatch = yield* runGitStdoutWithOptions(
      "GitCore.prepareCommitContext.stagedPatch",
      cwd,
      ["diff", "--cached", "--patch", "--minimal"],
      {
        maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    );

    return {
      stagedSummary,
      stagedPatch,
    };
  });

  const commit: GitCoreShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitCore.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = Effect.fn("pushCurrentBranch")(
    function* (cwd, fallbackBranch) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          publishRemoteName,
          `HEAD:refs/heads/${branch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: true,
        };
      }

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushUpstream", cwd, [
          "push",
          currentUpstream.remoteName,
          `HEAD:${currentUpstream.upstreamBranch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    },
  );

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = Effect.fn("pullCurrentBranch")(
    function* (cwd) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      });
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    },
  );

  const readRangeContext: GitCoreShape["readRangeContext"] = Effect.fn("readRangeContext")(
    function* (cwd, baseBranch) {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.log",
            cwd,
            ["log", "--oneline", range],
            {
              maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffStat",
            cwd,
            ["diff", "--stat", range],
            {
              maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffPatch",
            cwd,
            ["diff", "--patch", "--minimal", range],
            {
              maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    },
  );

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const isInsideWorkTree: GitCoreShape["isInsideWorkTree"] = (cwd) =>
    executeGit("GitCore.isInsideWorkTree", cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"));

  const listWorkspaceFiles: GitCoreShape["listWorkspaceFiles"] = (cwd) =>
    executeGit(
      "GitCore.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed({
              paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
              truncated: result.stdoutTruncated,
            })
          : Effect.fail(
              createGitCommandError(
                "GitCore.listWorkspaceFiles",
                cwd,
                [
                  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                  "ls-files",
                  "--cached",
                  "--others",
                  "--exclude-standard",
                  "-z",
                ],
                result.stderr.trim().length > 0 ? result.stderr.trim() : "git ls-files failed",
              ),
            ),
      ),
    );

  const filterIgnoredPaths: GitCoreShape["filterIgnoredPaths"] = (cwd, relativePaths) =>
    Effect.gen(function* () {
      if (relativePaths.length === 0) {
        return relativePaths;
      }

      const ignoredPaths = new Set<string>();
      const chunks = chunkPathsForGitCheckIgnore(relativePaths);

      for (const chunk of chunks) {
        const result = yield* executeGit(
          "GitCore.filterIgnoredPaths",
          cwd,
          [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
          {
            stdin: `${chunk.join("\0")}\0`,
            allowNonZeroExit: true,
            timeoutMs: 20_000,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        );

        if (result.code !== 0 && result.code !== 1) {
          return yield* createGitCommandError(
            "GitCore.filterIgnoredPaths",
            cwd,
            [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
            result.stderr.trim().length > 0 ? result.stderr.trim() : "git check-ignore failed",
          );
        }

        for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
          ignoredPaths.add(ignoredPath);
        }
      }

      if (ignoredPaths.size === 0) {
        return relativePaths;
      }

      return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
    });

  const listBranches: GitCoreShape["listBranches"] = Effect.fn("listBranches")(function* (input) {
    const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
      Effect.catch(() => Effect.succeed(new Map<string, number>())),
    );
    const localBranchResult = yield* executeGit(
      "GitCore.listBranches.branchNoColor",
      input.cwd,
      ["branch", "--no-color", "--no-column"],
      {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catchIf(isMissingGitCwdError, () =>
        Effect.succeed({
          code: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );

    if (localBranchResult.code !== 0) {
      const stderr = localBranchResult.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return {
          branches: [],
          isRepo: false,
          hasOriginRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }
      return yield* createGitCommandError(
        "GitCore.listBranches",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        stderr || "git branch failed",
      );
    }

    const remoteBranchResultEffect = executeGit(
      "GitCore.listBranches.remoteBranches",
      input.cwd,
      ["branch", "--no-color", "--no-column", "--remotes"],
      {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const remoteNamesResultEffect = executeGit(
      "GitCore.listBranches.remoteNames",
      input.cwd,
      ["remote"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
      yield* Effect.all(
        [
          executeGit(
            "GitCore.listBranches.defaultRef",
            input.cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          executeGit(
            "GitCore.listBranches.worktreeList",
            input.cwd,
            ["worktree", "list", "--porcelain"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          remoteBranchResultEffect,
          remoteNamesResultEffect,
          branchRecencyPromise,
        ],
        { concurrency: "unbounded" },
      );

    const remoteNames =
      remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
      );
    }
    if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }

    const defaultBranch =
      defaultRef.code === 0
        ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const worktreeMap = new Map<string, string>();
    if (worktreeList.code === 0) {
      let currentPath: string | null = null;
      for (const line of worktreeList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          const candidatePath = line.slice("worktree ".length);
          const exists = yield* fileSystem.stat(candidatePath).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          );
          currentPath = exists ? candidatePath : null;
        } else if (line.startsWith("branch refs/heads/") && currentPath) {
          worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
        } else if (line === "") {
          currentPath = null;
        }
      }
    }

    const localBranches = localBranchResult.stdout
      .split("\n")
      .map(parseBranchLine)
      .filter((branch): branch is { name: string; current: boolean } => branch !== null)
      .map((branch) => ({
        name: branch.name,
        current: branch.current,
        isRemote: false,
        isDefault: branch.name === defaultBranch,
        worktreePath: worktreeMap.get(branch.name) ?? null,
      }))
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    const remoteBranches =
      remoteBranchResult.code === 0
        ? remoteBranchResult.stdout
            .split("\n")
            .map(parseBranchLine)
            .filter((branch): branch is { name: string; current: boolean } => branch !== null)
            .map((branch) => {
              const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
              const remoteBranch: {
                name: string;
                current: boolean;
                isRemote: boolean;
                remoteName?: string;
                isDefault: boolean;
                worktreePath: string | null;
              } = {
                name: branch.name,
                current: false,
                isRemote: true,
                isDefault: false,
                worktreePath: null,
              };
              if (parsedRemoteRef) {
                remoteBranch.remoteName = parsedRemoteRef.remoteName;
              }
              return remoteBranch;
            })
            .toSorted((a, b) => {
              const aLastCommit = branchLastCommit.get(a.name) ?? 0;
              const bLastCommit = branchLastCommit.get(b.name) ?? 0;
              if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
              return a.name.localeCompare(b.name);
            })
        : [];

    const branches = paginateBranches({
      branches: filterBranchesForListQuery(
        dedupeRemoteBranchesWithLocalMatches([...localBranches, ...remoteBranches]),
        input.query,
      ),
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      branches: [...branches.branches],
      isRepo: true,
      hasOriginRemote: remoteNames.includes("origin"),
      nextCursor: branches.nextCursor,
      totalCount: branches.totalCount,
    };
  });

  const createWorktree: GitCoreShape["createWorktree"] = Effect.fn("createWorktree")(
    function* (input) {
      const targetBranch = input.newBranch ?? input.branch;
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
      const args = input.newBranch
        ? ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch]
        : ["worktree", "add", worktreePath, input.branch];

      yield* executeGit("GitCore.createWorktree", input.cwd, args, {
        fallbackErrorMessage: "git worktree add failed",
      });

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    },
  );

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = Effect.fn(
    "fetchPullRequestBranch",
  )(function* (input) {
    const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
    yield* executeGit(
      "GitCore.fetchPullRequestBranch",
      input.cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        remoteName,
        `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
      ],
      {
        fallbackErrorMessage: "git fetch pull request branch failed",
      },
    );
  });

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = Effect.fn("fetchRemoteBranch")(
    function* (input) {
      yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      yield* runGit(
        "GitCore.fetchRemoteBranch.materialize",
        input.cwd,
        localBranchAlreadyExists
          ? ["branch", "--force", input.localBranch, targetRef]
          : ["branch", input.localBranch, targetRef],
      );
    },
  );

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runGit("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitCoreShape["removeWorktree"] = Effect.fn("removeWorktree")(
    function* (input) {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error.message}`,
            error,
          ),
        ),
      );
    },
  );

  const renameBranch: GitCoreShape["renameBranch"] = Effect.fn("renameBranch")(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitCore.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const checkoutBranch: GitCoreShape["checkoutBranch"] = Effect.fn("checkoutBranch")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      const branch = yield* runGitStdout("GitCore.checkoutBranch.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { branch };
    },
  );

  const createBranch: GitCoreShape["createBranch"] = Effect.fn("createBranch")(function* (input) {
    yield* executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    });
    if (input.checkout) {
      yield* checkoutBranch({ cwd: input.cwd, branch: input.branch });
    }

    return { branch: input.branch };
  });

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  return {
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
    listBranches,
    createWorktree,
    fetchPullRequestBranch,
    ensureRemote,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
