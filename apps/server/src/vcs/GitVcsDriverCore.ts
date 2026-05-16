import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, type VcsRef } from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerConfig } from "../config.ts";
const isGitCommandError = Schema.is(GitCommandError);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
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
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
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
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
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
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
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
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
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
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
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
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    isGitCommandError(cause)
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

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(Effect.catch(() => Effect.void));

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
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
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
        `GitVcsDriver.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
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
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
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
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
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

const collectOutput = Effect.fnUntraced(function* <E>(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
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

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

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

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { worktreesDir } = yield* ServerConfig;

  const executeRaw: GitVcsDriver.GitVcsDriverShape["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

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
              appendTruncationMarker,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
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
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
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
    },
  );

  const execute: GitVcsDriver.GitVcsDriverShape["execute"] = (input) =>
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
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
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
            `${commandLabel(args)} failed: code=${result.exitCode ?? "null"}`,
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

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

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
      "GitVcsDriver.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitVcsDriver.fetchRemoteForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
      {
        allowNonZeroExit: true,
        env: STATUS_UPSTREAM_REFRESH_ENV,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* runGitStdout("GitVcsDriver.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
  });

  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName);
    return true as const;
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
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
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
      }),
    );
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    refName: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitVcsDriver.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.catch(() => Effect.succeed([])));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

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
      "GitVcsDriver.resolvePrimaryRemoteName",
      cwd,
      ["remote"],
      "No git remote is configured for this repository.",
    );
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriverShape["ensureRemote"] = Effect.fn("ensureRemote")(
    function* (input) {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeRemoteUrl(input.url);
      const remoteFetchUrls = yield* runGitStdout(
        "GitVcsDriver.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

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

      yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        remoteName,
        input.url,
      ]);
      return remoteName;
    },
  );

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
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
      if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
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
    refName: string,
  ) {
    const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);
    if (!baseRef) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readBranchRecency = Effect.fn("readBranchRecency")(function* (cwd: string) {
    const branchRecency = yield* executeGit(
      "GitVcsDriver.readBranchRecency",
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
    if (branchRecency.exitCode !== 0) {
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
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      const stderr = statusResult.stderr.trim();
      return yield* createGitCommandError(
        "GitVcsDriver.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        stderr || "git status failed",
      );
    }

    const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasPrimaryRemote] =
      yield* Effect.all(
        [
          runGitStdout("GitVcsDriver.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitVcsDriver.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
          executeGit(
            "GitVcsDriver.statusDetails.defaultRef",
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
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let refName: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
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

    const fallbackAheadCount =
      !upstreamRef && refName
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(
            Effect.catch(() => Effect.succeed(0)),
          )
        : null;

    if (fallbackAheadCount !== null) {
      aheadCount = fallbackAheadCount;
      behindCount = 0;
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    if (refName && !isDefaultBranch) {
      aheadOfDefaultCount =
        fallbackAheadCount !== null
          ? fallbackAheadCount
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(
              Effect.catch(() => Effect.succeed(0)),
            );
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
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
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
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriverShape["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriverShape["statusDetails"] = Effect.fn("statusDetails")(
    function* (cwd) {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(
        Effect.catchIf(isMissingGitCwdError, () => Effect.void),
        Effect.ignoreCause({ log: true }),
      );
      return yield* readStatusDetailsLocal(cwd);
    },
  );

  const status: GitVcsDriver.GitVcsDriverShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitVcsDriver.GitVcsDriverShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    if (filePaths && filePaths.length > 0) {
      yield* runGit("GitVcsDriver.prepareCommitContext.reset", cwd, ["reset"]).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* runGit("GitVcsDriver.prepareCommitContext.addSelected", cwd, [
        "add",
        "-A",
        "--",
        ...filePaths,
      ]);
    } else {
      yield* runGit("GitVcsDriver.prepareCommitContext.addAll", cwd, ["add", "-A"]);
    }

    const stagedSummary = yield* runGitStdout(
      "GitVcsDriver.prepareCommitContext.stagedSummary",
      cwd,
      ["diff", "--cached", "--name-status"],
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatch = yield* runGitStdoutWithOptions(
      "GitVcsDriver.prepareCommitContext.stagedPatch",
      cwd,
      ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
      {
        maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );

    return {
      stagedSummary,
      stagedPatch,
    };
  });

  const commit: GitVcsDriver.GitVcsDriverShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
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
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriverShape["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* createGitCommandError(
        "GitVcsDriver.pushCurrentBranch",
        cwd,
        ["push"],
        "Cannot push from detached HEAD.",
      );
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote", cwd, [
        "push",
        "-u",
        requestedRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
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
          "GitVcsDriver.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push because no git remote is configured for this repository.",
        );
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithUpstream", cwd, [
        "push",
        "-u",
        publishRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (currentUpstream) {
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushUpstream", cwd, [
        "push",
        currentUpstream.remoteName,
        `HEAD:refs/heads/${currentUpstream.branchName}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"]);
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriverShape["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* createGitCommandError(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        ["pull", "--ff-only"],
        "Cannot pull from detached HEAD.",
      );
    }
    if (!details.hasUpstream) {
      return yield* createGitCommandError(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        ["pull", "--ff-only"],
        "Current branch has no upstream configured. Push with upstream first.",
      );
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorMessage: "git pull failed",
    });
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* statusDetails(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriverShape["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const range = `${baseRef}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", range],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", range],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-ext-diff", "--patch", "--minimal", range],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
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
  });

  const readConfigValue: GitVcsDriver.GitVcsDriverShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const listRefs: GitVcsDriver.GitVcsDriverShape["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const localBranchResult = yield* executeGit(
        "GitVcsDriver.listRefs.branchNoColor",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchIf(isMissingGitCwdError, () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(128),
            stdout: "",
            stderr: "fatal: not a git repository",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      );

      if (localBranchResult.exitCode !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return {
            refs: [],
            isRepo: false,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        }
        return yield* createGitCommandError(
          "GitVcsDriver.listRefs",
          input.cwd,
          ["branch", "--no-color", "--no-column"],
          stderr || "git branch failed",
        );
      }

      const remoteBranchResultEffect = executeGit(
        "GitVcsDriver.listRefs.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--no-column", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitVcsDriver.listRefs: remote refName lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote refName list.`,
          ).pipe(
            Effect.as({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            } satisfies GitVcsDriver.ExecuteGitResult),
          ),
        ),
      );

      const remoteNamesResultEffect = executeGit(
        "GitVcsDriver.listRefs.remoteNames",
        input.cwd,
        ["remote"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitVcsDriver.listRefs: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
          ).pipe(
            Effect.as({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            } satisfies GitVcsDriver.ExecuteGitResult),
          ),
        ),
      );

      const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
        yield* Effect.all(
          [
            executeGit(
              "GitVcsDriver.listRefs.defaultRef",
              input.cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitVcsDriver.listRefs.worktreeList",
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
        remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
      if (remoteBranchResult.exitCode !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitVcsDriver.listRefs: remote refName lookup returned code ${remoteBranchResult.exitCode} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote refName list.`,
        );
      }
      if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRef.exitCode === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.exitCode === 0) {
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
        .filter((refName): refName is { name: string; current: boolean } => refName !== null)
        .map((refName) => ({
          name: refName.name,
          current: refName.current,
          isRemote: false,
          isDefault: refName.name === defaultBranch,
          worktreePath: worktreeMap.get(refName.name) ?? null,
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
        remoteBranchResult.exitCode === 0
          ? remoteBranchResult.stdout
              .split("\n")
              .map(parseBranchLine)
              .filter((refName): refName is { name: string; current: boolean } => refName !== null)
              .map((refName) => {
                const parsedRemoteRef = parseRemoteRefWithRemoteNames(refName.name, remoteNames);
                const remoteBranch: {
                  name: string;
                  current: boolean;
                  isRemote: boolean;
                  remoteName?: string;
                  isDefault: boolean;
                  worktreePath: string | null;
                } = {
                  name: refName.name,
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

      const refs = paginateBranches({
        refs: filterBranchesForListQuery(
          dedupeRemoteBranchesWithLocalMatches([...localBranches, ...remoteBranches]),
          input.query,
        ),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: remoteNames.includes("origin"),
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriverShape["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    const args = input.newRefName
      ? ["worktree", "add", "-b", input.newRefName, worktreePath, input.refName]
      : ["worktree", "add", worktreePath, input.refName];

    yield* executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
      fallbackErrorMessage: "git worktree add failed",
    });

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriverShape["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
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

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriverShape["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriverShape["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    yield* executeGit("GitVcsDriver.removeWorktree", input.cwd, args, {
      timeoutMs: 15_000,
      fallbackErrorMessage: "git worktree remove failed",
    }).pipe(
      Effect.mapError((error) =>
        createGitCommandError(
          "GitVcsDriver.removeWorktree",
          input.cwd,
          args,
          `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error.message}`,
          error,
        ),
      ),
    );
  });

  const renameBranch: GitVcsDriver.GitVcsDriverShape["renameBranch"] = Effect.fn("renameBranch")(
    function* (input) {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitVcsDriver.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    },
  );

  const switchRef: GitVcsDriver.GitVcsDriverShape["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriverShape["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriverShape["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriverShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
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

  return GitVcsDriver.GitVcsDriver.of({
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
    listRefs,
    createWorktree,
    fetchPullRequestBranch,
    ensureRemote,
    resolvePrimaryRemoteName,
    fetchRemoteBranch,
    fetchRemoteTrackingBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createRef,
    switchRef,
    initRepo,
    listLocalBranchNames,
  });
});
