import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { GitCommandError } from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { gitConfigEnv } from "../VcsProcess.ts";
import { DEFAULT_TIMEOUT_MS, branchBaseConfigKey, legacyBranchBaseConfigKey, gitProcesses, WORKTREE_REMOVE_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, OUTPUT_TRUNCATED_MARKER, PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES, RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES, RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES, RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES, REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES, REVIEW_METADATA_MAX_OUTPUT_BYTES, REVIEW_UNTRACKED_MAX_FILES, REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES, REVIEW_BRANCH_COMMIT_LIMIT, REVIEW_BRANCH_SUBJECT_LIMIT, REVIEW_BRANCH_COMMIT_MAX_OUTPUT_BYTES, PATCH_RENDER_PREFIX_ARGS, REVIEW_DIFF_ARGS, STATUS_UPSTREAM_REFRESH_INTERVAL, STATUS_UPSTREAM_REFRESH_TIMEOUT, STATUS_UPSTREAM_FETCH_TIMEOUT, STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN, STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN, STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY, REPOSITORY_PATHS_CACHE_CAPACITY, REPOSITORY_PATHS_CACHE_TTL, REPOSITORY_PATHS_REFRESH_COALESCE_TTL, NON_REPOSITORY_PATHS_CACHE_TTL, LIST_REFS_SNAPSHOT_CACHE_CAPACITY, LIST_REFS_SNAPSHOT_CACHE_TTL, LIST_REFS_REFRESH_COALESCE_TTL, LIST_REFS_REFRESH_FAILURE_COOLDOWN, STATUS_DEFAULT_BRANCH_CACHE_TTL, STATUS_ORIGIN_EXISTS_CACHE_TTL, STATUS_UPSTREAM_REFRESH_ENV, DEFAULT_BASE_BRANCH_CANDIDATES, GIT_LIST_BRANCHES_DEFAULT_LIMIT, NON_REPOSITORY_STATUS_DETAILS, NON_REPOSITORY_REMOTE_STATUS_DETAILS, StatusRemoteRefreshCacheKey, statusUpstreamRefreshFailureCooldown, GitRefsSnapshotCacheKey, GitRefsRefreshCacheKey, parseBranchAb, parseReviewNumstat, PORCELAIN_V2_FIELDS_BEFORE_PATH, parsePorcelainPath, filterBranchesForListQuery, paginateBranches, parseWorktreeBranchPaths, splitNullSeparatedPaths, splitNullSeparatedGitStdoutPaths, refuseOptionLikeRefName, sanitizeRemoteName, parseRemoteFetchUrls, parseUpstreamRefWithRemoteNames, parseUpstreamRefByFirstSeparator, parseTrackingBranchByUpstreamRef, deriveLocalBranchNameFromRemoteRef, gitCommandContext, GIT_FAILURE_REASON_PATTERNS, GIT_FAILURE_REASON_DETAILS, gitFailureDetail, GIT_NOT_A_COMMIT_PATTERN, GIT_DIAGNOSTIC_LINE_PATTERN, SSH_TRANSPORT_REFUSAL_PATTERN, classifyGitFailure, branchNameFromHeadRef, parseDefaultBranchFromRemoteHeadRef, isMissingGitCwdError, isNonRepositoryGitStderr, isUnbornHeadStderr, isMissingWorktreeStderr, fetchFailureDetail, isRefLockFailure, nowUnixNano, addCurrentSpanEvent, trace2ChildKey, Trace2Record, decodeTrace2Record, type TraceTailState, type GitRepositoryPaths, type GitRefsSnapshot, type ExecuteGitOptions, type Trace2Monitor } from "./FetchFailureDetail.ts";

export const createTrace2Monitor = Effect.fnUntraced(function* (
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

  const traceRecord = decodeTrace2Record(trimmedLine);
  if (Result.isFailure(traceRecord)) {
    yield* Effect.logDebug(
      `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
      traceRecord.failure,
    );
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
    if (traceRecord.success.child_class !== "hook") {
      return;
    }
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

  if (event === "child_exit" && started) {
    hookStartByChildKey.delete(childKey);
    const code = traceRecord.success.code;
    const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
    const now = yield* DateTime.now;
    const durationMs = Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs);
    yield* addCurrentSpanEvent("git.hook.finished", {
      hookName: started.hookName,
      exitCode,
      durationMs,
    });
    if (progress.onHookFinished) {
      yield* progress.onHookFinished({
        hookName: started.hookName,
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

export const GIT_CHECKOUT_PROGRESS_LINE = /Updating files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/;

export function parseGitCheckoutProgressLine(
line: string,
): { percent: number; completed: number; total: number } | null {
const match = GIT_CHECKOUT_PROGRESS_LINE.exec(line);
if (!match) return null;
const percent = Number(match[1]);
const completed = Number(match[2]);
const total = Number(match[3]);
if (!Number.isFinite(percent) || !Number.isFinite(completed) || !Number.isFinite(total)) {
  return null;
}
return { percent: Math.max(0, Math.min(100, percent)), completed, total };
}

export const OUTPUT_LINE_SEPARATOR = /\r\n|\r|\n/;

export const collectOutput = Effect.fnUntraced(function* (
input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
maxOutputBytes: number,
appendTruncationMarker: boolean,
onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
keepLineCallbacksAfterTruncation = false,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const lineDecoder = keepLineCallbacksAfterTruncation && onLine ? new TextDecoder() : null;
let bytes = 0;
let text = "";
let lineBuffer = "";
let truncated = false;
// Bound newline-free output; oversized lines are not useful to callbacks.
const maxPendingLineBytes = 64 * 1024;

// Git redraws progress with bare CR; treat it as a line break.
const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
  let separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
  while (separator) {
    const line = lineBuffer.slice(0, separator.index);
    lineBuffer = lineBuffer.slice(separator.index + separator[0].length);
    if (line.length > 0 && onLine) {
      yield* onLine(line);
    }
    separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
  }

  if (flush) {
    const trailing = lineBuffer;
    lineBuffer = "";
    if (trailing.length > 0 && onLine) {
      yield* onLine(trailing);
    }
  }
});

const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
  if (appendTruncationMarker && truncated) {
    if (lineDecoder) {
      lineBuffer += lineDecoder.decode(chunk, { stream: true });
      yield* emitCompleteLines(false);
      if (lineBuffer.length > maxPendingLineBytes) lineBuffer = "";
    }
    return;
  }
  const nextBytes = bytes + chunk.byteLength;
  if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
    return yield* new GitCommandError({
      ...gitCommandContext(input),
      detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
      outputLength: nextBytes,
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
  if (onLine) {
    lineBuffer += lineDecoder ? lineDecoder.decode(chunk, { stream: true }) : decoded;
    yield* emitCompleteLines(false);
  }
});

yield* Stream.runForEach(stream, processChunk).pipe(
  Effect.catchTags({
    PlatformError: (cause) =>
      new GitCommandError({
        ...gitCommandContext(input),
        detail: "Failed to read Git process output.",
        cause,
      }),
  }),
);

const remainder = truncated ? "" : decoder.decode();
text += remainder;
if (onLine) {
  lineBuffer += remainder;
  if (lineDecoder) lineBuffer += lineDecoder.decode();
  yield* emitCompleteLines(true);
}
return {
  text,
  truncated,
};
});

export const windowsLongPathConfigEnv = (
platform: NodeJS.Platform,
env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
platform === "win32" ? gitConfigEnv(env, "core.longpaths", "true", platform) : {};
