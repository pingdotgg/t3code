import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
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

import {
  GitCommandError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  type VcsRef,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches, normalizeGitRemoteUrl } from "@t3tools/shared/git";
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

const DEFAULT_TIMEOUT_MS = 30_000;
// `git worktree add` checks out the full tree, so on large repositories it can
// take well beyond the default 30s (e.g. a 375k-file repo takes ~40s on an idle
// machine). Give it generous headroom while still bounding a genuinely hung git.
const WORKTREE_ADD_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 120_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);
const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);
const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);
const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);
const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);
const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
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
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  defaultBranch: null,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
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

function statusUpstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

class GitRefsSnapshotCacheKey extends Data.Class<{
  gitCommonDir: string;
  epoch: number;
}> {}

class GitRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  generation: number;
}> {}

interface GitRepositoryPaths {
  readonly gitCommonDir: string;
  readonly worktreeRoot: string | null;
  readonly currentBranch: string | null;
}

interface GitRefsSnapshot {
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | null | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
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

function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
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

function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
  return {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const;
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

function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.cause.reason;
  if (reason._tag === "NotFound") {
    return reason.pathOrDescriptor === error.cwd;
  }

  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}
function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
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
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.void,
    }),
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
        `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
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

const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
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
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
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
  const crypto = yield* Crypto.Crypto;

  const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to create Git trace monitor.",
                cause,
              }),
          ),
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
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to spawn Git process.",
                  cause,
                }),
            ),
          );

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
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to read Git process exit code.",
                    cause,
                  }),
              ),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        ...gitCommandContext(commandInput),
                        detail: "Failed to write Git process input.",
                        cause,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          return yield* new GitCommandError({
            ...gitCommandContext(commandInput),
            detail: "Git command exited with a non-zero status.",
            exitCode,
            stdoutLength: stdout.text.length,
            stderrLength: stderr.text.length,
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

      const execution = runGitCommand().pipe(Effect.scoped);
      if (timeoutMs === null) {
        return yield* execution;
      }

      return yield* execution.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Git command timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  );

  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
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
        return Effect.fail(
          new GitCommandError({
            ...gitCommandContext({ operation, cwd, args }),
            detail: options.fallbackErrorDetail ?? "Git command exited with a non-zero status.",
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
        );
      }),
    );

  const executeGitWithStableDiagnostics = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    executeGit(operation, cwd, args, {
      ...options,
      env: {
        ...options.env,
        LC_ALL: "C",
      },
    });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

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

    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.renameBranch",
        cwd,
        args: ["branch", "-m", "--", desiredBranch],
      }),
      detail: `Could not find an available branch name for '${desiredBranch}'.`,
    });
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
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
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
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
    cwd: string,
  ) {
    const commonDirResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.resolveRepositoryPaths.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    );
    if (commonDirResult.exitCode !== 0) {
      const stderr = commonDirResult.stderr.trim();
      if (isNonRepositoryGitStderr(stderr)) {
        return null;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        }),
        detail: "Failed to resolve the Git common directory.",
        exitCode: commonDirResult.exitCode,
        stdoutLength: commonDirResult.stdout.length,
        stderrLength: commonDirResult.stderr.length,
      });
    }

    const commonDirOutput = commonDirResult.stdout.trim();
    const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
      ? path.normalize(commonDirOutput)
      : path.resolve(cwd, commonDirOutput);
    const gitCommonDir = yield* fileSystem
      .realPath(resolvedGitCommonDir)
      .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));
    const [worktreeRootResult, currentBranchResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
          cwd,
          ["rev-parse", "--show-toplevel"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.currentBranch",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
      ],
      { concurrency: 2 },
    );
    const worktreeRootOutput = worktreeRootResult.stdout.trim();
    const worktreeRoot =
      worktreeRootResult.exitCode === 0 && worktreeRootOutput.length > 0
        ? path.normalize(
            path.isAbsolute(worktreeRootOutput)
              ? worktreeRootOutput
              : path.resolve(cwd, worktreeRootOutput),
          )
        : null;
    const currentBranchOutput = currentBranchResult.stdout.trim();
    const currentBranch =
      currentBranchResult.exitCode === 0 && currentBranchOutput.length > 0
        ? currentBranchOutput
        : null;

    return {
      gitCommonDir,
      worktreeRoot,
      currentBranch,
    } satisfies GitRepositoryPaths;
  });

  const repositoryPathsCache = yield* Cache.makeWith(
    (cwd: string) => resolveRepositoryPathsUncached(cwd),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const repositoryPathsRefreshCache = yield* Cache.makeWith(
    (cwd: string) =>
      Cache.invalidate(repositoryPathsCache, cwd).pipe(
        Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
      ),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null
            ? NON_REPOSITORY_PATHS_CACHE_TTL
            : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));
  const resolveRepositoryPaths = (cwd: string, refresh = false) => {
    const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
    return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
  };

  const defaultBranchCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.defaultBranch",
          fetchCwd,
          ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) return null;
            return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
          }),
        );
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const originExistsCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.originExists",
          fetchCwd,
          ["--git-dir", gitCommonDir, "remote", "get-url", "origin"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.exitCode === 0));
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const invalidateStatusStaticCaches = (cwd: string) =>
    Effect.gen(function* () {
      const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
        Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
      );
      const cacheKey = repositoryPaths?.gitCommonDir ?? normalizeRepositoryPathsCacheKey(cwd);
      yield* Cache.invalidate(defaultBranchCache, cacheKey);
      yield* Cache.invalidate(originExistsCache, cacheKey);
    });

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const repositoryPaths = yield* resolveRepositoryPaths(cwd);
    if (repositoryPaths !== null) {
      return repositoryPaths.gitCommonDir;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      }),
      detail: "Cannot resolve a Git common directory outside a repository.",
    });
  });

  const statusRemoteRefreshFailureCounts = new Map<string, number>();
  const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
    `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;
  const recordStatusRemoteRefreshFailure = (cacheKey: StatusRemoteRefreshCacheKey) => {
    const key = statusRemoteRefreshFailureKey(cacheKey);
    const nextCount = (statusRemoteRefreshFailureCounts.get(key) ?? 0) + 1;
    statusRemoteRefreshFailureCounts.delete(key);
    statusRemoteRefreshFailureCounts.set(key, nextCount);
    if (statusRemoteRefreshFailureCounts.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
      const oldestKey = statusRemoteRefreshFailureCounts.keys().next().value;
      if (oldestKey !== undefined) {
        statusRemoteRefreshFailureCounts.delete(oldestKey);
      }
    }
  };
  const clearStatusRemoteRefreshFailures = (cacheKey: StatusRemoteRefreshCacheKey) => {
    statusRemoteRefreshFailureCounts.delete(statusRemoteRefreshFailureKey(cacheKey));
  };
  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
      Effect.tap(() => Effect.sync(() => clearStatusRemoteRefreshFailures(cacheKey))),
      Effect.tapError(() => Effect.sync(() => recordStatusRemoteRefreshFailure(cacheKey))),
      Effect.as(true as const),
    );
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // A failed background fetch is intentionally cached and exponentially
    // backed off. Status reads swallow this failure and use the last fetched
    // refs, so repeated thread mounts cannot turn a slow or unavailable remote
    // into a repository-wide Git subprocess storm.
    timeToLive: (exit, cacheKey) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : statusUpstreamRefreshFailureCooldown(
            statusRemoteRefreshFailureCounts.get(statusRemoteRefreshFailureKey(cacheKey)) ?? 1,
          ),
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

  const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
    executeGit("GitVcsDriver.remoteExists", input.cwd, ["remote", "get-url", input.remoteName], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    remoteExists({ cwd, remoteName: "origin" });

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
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
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolvePrimaryRemoteName",
        cwd,
        args: ["remote"],
      }),
      detail: "No git remote is configured for this repository.",
    });
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

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "ensureRemote",
  )(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeGitRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout(
      "GitVcsDriver.ensureRemote.listRemoteUrls",
      input.cwd,
      ["remote", "-v"],
    ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeGitRemoteUrl(remoteUrl) === normalizedTargetUrl) {
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
  });

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
      Effect.orElseSucceed(() => null),
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

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
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

  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    let branch: string | null;
    if (branchResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(branchResult.stderr)) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }
      if (!isUnbornHeadStderr(branchResult.stderr)) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.statusDetailsRemote.branch",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
          }),
          detail: "Git branch lookup failed.",
          exitCode: branchResult.exitCode,
          stdoutLength: branchResult.stdout.length,
          stderrLength: branchResult.stderr.length,
        });
      }

      const branchValue = yield* runGitStdout(
        "GitVcsDriver.statusDetailsRemote.unbornBranch",
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
      );
      branch = branchValue.trim() || null;
    } else {
      const branchValue = branchResult.stdout.trim();
      branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
    }
    const upstream = yield* resolveCurrentUpstream(cwd);
    const upstreamRef = upstream?.upstreamRef ?? null;
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.orElseSucceed(() => 0),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
        : 0;

    return {
      isRepo: true,
      defaultBranch,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const statusResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(statusResult.stderr)) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetails.status",
          cwd,
          args: ["status", "--porcelain=2", "--branch"],
        }),
        detail: "Git status failed.",
        exitCode: statusResult.exitCode,
        stdoutLength: statusResult.stdout.length,
        stderrLength: statusResult.stderr.length,
      });
    }

    const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
      Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
    );
    const statusCacheKey = repositoryPaths?.gitCommonDir;
    const [numstatStdout, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.statusDetails.numstat",
          cwd,
          ["diff", "HEAD", "--numstat", "--"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(result.stdout);
            if (isUnbornHeadStderr(result.stderr)) {
              return Effect.map(
                Effect.all([
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn", cwd, [
                    "diff",
                    "--numstat",
                  ]),
                  runGitStdout("GitVcsDriver.statusDetails.numstat.unborn.staged", cwd, [
                    "diff",
                    "--cached",
                    "--numstat",
                  ]),
                ]),
                ([unstagedStdout, stagedStdout]) => {
                  const staged = parseNumstatEntries(stagedStdout);
                  const unstaged = parseNumstatEntries(unstagedStdout);
                  const map = new Map<string, { insertions: number; deletions: number }>();
                  for (const entry of [...staged, ...unstaged]) {
                    const existing = map.get(entry.path) ?? {
                      insertions: 0,
                      deletions: 0,
                    };
                    existing.insertions += entry.insertions;
                    existing.deletions += entry.deletions;
                    map.set(entry.path, existing);
                  }
                  return Array.from(map.entries())
                    .map(([p, s]) => `${s.insertions}\t${s.deletions}\t${p}`)
                    .join("\n");
                },
              );
            }
            return Effect.fail(
              new GitCommandError({
                ...gitCommandContext({
                  operation: "GitVcsDriver.statusDetails.numstat",
                  cwd,
                  args: ["diff", "HEAD", "--numstat", "--"],
                }),
                detail: "git diff HEAD --numstat failed.",
                exitCode: result.exitCode,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            );
          }),
        ),
        statusCacheKey
          ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
          : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
        statusCacheKey
          ? Cache.get(originExistsCache, statusCacheKey).pipe(Effect.orElseSucceed(() => false))
          : originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
      ],
      { concurrency: "unbounded" },
    );
    const statusStdout = statusResult.stdout;

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
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0))
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
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0));
    }

    const numstatEntries = parseNumstatEntries(numstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of numstatEntries) {
      fileStatMap.set(entry.path, { insertions: entry.insertions, deletions: entry.deletions });
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

  const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
    "statusDetails",
  )(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
      }),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
    Effect.fn("statusDetailsRemote")(function* (cwd, options) {
      if (options?.refreshUpstream !== false) {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
          }),
          Effect.ignoreCause({ log: true }),
        );
      }
      return yield* readStatusDetailsRemote(cwd);
    });

  const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
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

  const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
    Effect.fn("prepareCommitContext")(function* (cwd, filePaths) {
      if (filePaths && filePaths.length > 0) {
        yield* runGit("GitVcsDriver.prepareCommitContext.reset", cwd, ["reset"]).pipe(
          Effect.catchTags({
            GitCommandError: () => Effect.void,
          }),
        );
        yield* runGit("GitVcsDriver.prepareCommitContext.addSelected", cwd, [
          "--literal-pathspecs",
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

  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
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

  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push from detached HEAD.",
      });
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
        cwd,
        ["push", "-u", requestedRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
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
        Effect.orElseSucceed(() => null),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
          Effect.orElseSucceed(() => false),
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
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pushCurrentBranch",
            cwd,
            args: ["push"],
          }),
          detail: "Cannot push because no git remote is configured for this repository.",
        });
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithUpstream",
        cwd,
        ["push", "-u", publishRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (currentUpstream) {
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushUpstream",
        cwd,
        ["push", currentUpstream.remoteName, `HEAD:refs/heads/${currentUpstream.branchName}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"], { timeoutMs: null });
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Cannot pull from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Current branch has no upstream configured. Push with upstream first.",
      });
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorDetail: "git pull failed",
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

  const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
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

  const readUntrackedReviewDiffs = Effect.fn("readUntrackedReviewDiffs")(function* (cwd: string) {
    const untrackedResult = yield* executeGit(
      "GitVcsDriver.readUntrackedReviewDiffs.list",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult);
    if (untrackedPaths.length === 0) {
      return { diff: "", truncated: untrackedResult.stdoutTruncated };
    }

    const diffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        executeGit(
          "GitVcsDriver.readUntrackedReviewDiffs.diff",
          cwd,
          [
            "diff",
            "--no-index",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            "--",
            "/dev/null",
            relativePath,
          ],
          {
            allowNonZeroExit: true,
            maxOutputBytes: REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      { concurrency: 4 },
    );

    return {
      diff: Arr.filterMap(diffs, (result) =>
        result.stdout.trim().length > 0 ? Result.succeed(result.stdout) : Result.failVoid,
      ).join("\n"),
      truncated: untrackedResult.stdoutTruncated || diffs.some((result) => result.stdoutTruncated),
    };
  });

  const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const details = yield* statusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const branch = details.branch;
    const baseRef =
      input.baseRef ??
      (branch
        ? yield* resolveBaseBranchForNoUpstream(input.cwd, branch).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null);

    const dirtyTrackedResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.dirtyTracked",
      input.cwd,
      [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
        "--",
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.orElseSucceed(() => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
    );
    const dirtyUntracked = yield* readUntrackedReviewDiffs(input.cwd).pipe(
      Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
    );
    const dirtyDiff = [dirtyTrackedResult.stdout.trimEnd(), dirtyUntracked.diff.trimEnd()]
      .filter((diff) => diff.length > 0)
      .join("\n");

    const baseResult =
      baseRef && branch
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.base",
            input.cwd,
            [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--minimal",
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              `${baseRef}...HEAD`,
            ],
            {
              maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
              appendTruncationMarker: true,
            },
          ).pipe(
            Effect.orElseSucceed(() => ({
              exitCode: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          )
        : null;
    const baseDiff = baseResult?.stdout ?? "";
    const hashDiff = (diff: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd: input.cwd,
              detail: "Failed to hash review diff.",
              cause,
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirtyDiff),
      hashDiff(baseDiff),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: dirtyDiff,
        diffHash: dirtyDiffHash,
        truncated: dirtyTrackedResult.stdoutTruncated || dirtyUntracked.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef: branch ?? "HEAD",
        diff: baseDiff,
        diffHash: baseDiffHash,
        truncated: baseResult?.stdoutTruncated ?? false,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    };
  });

  const reviewDiffFileError = (
    input: ReviewDiffFileContentsInput,
    detail: string,
    cause?: unknown,
  ) =>
    new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffFileContents",
      command: "git",
      cwd: input.cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const readReviewFileAtRevision = Effect.fn("readReviewFileAtRevision")(function* (
    input: ReviewDiffFileContentsInput,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffFileContents.revision",
      input.cwd,
      ["show", `${revision}:${relativePath}`],
      { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.stdout.includes("\0")) {
      return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
    }
    return result.stdout;
  });

  const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
  ) {
    const fileError = (stage: string, detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: `GitVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
        command: stage,
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const requestedPath = path.resolve(repositoryRoot, input.newPath);
    if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
      return yield* fileError(
        "path.resolve",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const [realRepositoryRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(requestedPath),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
      ),
    );
    if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
      return yield* fileError(
        "fs.realPath",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
    }
    if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
      return yield* fileError(
        "fs.stat",
        `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
      );
    }

    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
    }
    return new TextDecoder("utf-8").decode(bytes);
  });

  const getReviewDiffFileContents = Effect.fn("getReviewDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
  ) {
    if (input.sourceKind === "working-tree") {
      const repositoryRoot = yield* runGitStdout(
        "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
        input.cwd,
        ["rev-parse", "--show-toplevel"],
      ).pipe(Effect.map((value) => value.trim()));
      if (repositoryRoot.length === 0) {
        return yield* reviewDiffFileError(input, "Could not resolve the Git repository root.");
      }
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readReviewFileAtRevision(input, input.baseRef ?? "HEAD", input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readWorkingTreeReviewFile(input, repositoryRoot),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }

    if (!input.baseRef || !input.headRef) {
      return yield* reviewDiffFileError(
        input,
        "Branch diff file expansion requires both base and head refs.",
      );
    }
    const mergeBase = yield* runGitStdout(
      "GitVcsDriver.getReviewDiffFileContents.mergeBase",
      input.cwd,
      ["merge-base", input.baseRef, input.headRef],
    ).pipe(Effect.map((value) => value.trim()));
    if (mergeBase.length === 0) {
      return yield* reviewDiffFileError(input, "Could not resolve the branch comparison base.");
    }
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, mergeBase, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, input.headRef, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const gitDirArgs = ["--git-dir", gitCommonDir] as const;
    const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.listRefs.snapshotRefs",
          fetchCwd,
          [
            ...gitDirArgs,
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 30_000,
            maxOutputBytes: 16 * 1024 * 1024,
            fallbackErrorDetail: "Git ref snapshot enumeration failed.",
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.defaultRef",
          fetchCwd,
          [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.worktreeList",
          fetchCwd,
          [...gitDirArgs, "worktree", "list", "--porcelain", "-z"],
          {
            timeoutMs: 30_000,
            allowNonZeroExit: true,
            maxOutputBytes: 16 * 1024 * 1024,
          },
        ),
        executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: 2 },
    );

    const remoteNames =
      remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;
    const parsedWorktreeEntries =
      worktreeListResult.exitCode === 0
        ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
            ([branchName, worktreePath]) =>
              [branchName, path.normalize(path.resolve(worktreePath))] as const,
          )
        : [];
    const existingWorktreeEntries = yield* Effect.filter(
      parsedWorktreeEntries,
      ([, worktreePath]) =>
        fileSystem.stat(worktreePath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: 16 },
    );
    const worktreeMap = new Map(existingWorktreeEntries);
    const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
    const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];

    for (const line of refsResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");
      if (!fullRefName || symbolicTarget) continue;
      const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

      if (fullRefName.startsWith("refs/heads/")) {
        const name = fullRefName.slice("refs/heads/".length);
        localBranches.push({
          ref: {
            name,
            current: false,
            isRemote: false,
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          },
          lastCommit,
        });
        continue;
      }
      if (!fullRefName.startsWith("refs/remotes/")) continue;

      const name = fullRefName.slice("refs/remotes/".length);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
      const remoteBranch: VcsRef = {
        name,
        current: false,
        isRemote: true,
        isDefault:
          defaultBranch !== null &&
          parsedRemoteRef?.remoteName === "origin" &&
          parsedRemoteRef.branchName === defaultBranch,
        worktreePath: null,
        ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
      };
      remoteBranches.push({ ref: remoteBranch, lastCommit });
    }

    const byRecencyThenName = (
      left: { readonly ref: VcsRef; readonly lastCommit: number },
      right: { readonly ref: VcsRef; readonly lastCommit: number },
    ) =>
      left.lastCommit !== right.lastCommit
        ? right.lastCommit - left.lastCommit
        : left.ref.name.localeCompare(right.ref.name);

    return {
      localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      hasPrimaryRemote: remoteNames.includes("origin"),
    } satisfies GitRefsSnapshot;
  });

  const listRefsEpochByCommonDir = new Map<string, number>();
  let listRefsEpochSequence = 0;
  const bumpListRefsEpoch = (gitCommonDir: string): number => {
    const nextEpoch = ++listRefsEpochSequence;
    listRefsEpochByCommonDir.delete(gitCommonDir);
    listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);
    if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsEpochByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsEpochByCommonDir.delete(oldestKey);
      }
    }
    return nextEpoch;
  };
  const listRefsGenerationByCommonDir = new Map<string, number>();
  let listRefsGenerationSequence = 0;
  const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
    listRefsGenerationByCommonDir.delete(gitCommonDir);
    listRefsGenerationByCommonDir.set(gitCommonDir, generation);
    if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsGenerationByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsGenerationByCommonDir.delete(oldestKey);
      }
    }
    return generation;
  };
  const currentListRefsGeneration = (gitCommonDir: string): number => {
    const current = listRefsGenerationByCommonDir.get(gitCommonDir);
    return current === undefined
      ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
      : setListRefsGeneration(gitCommonDir, current);
  };
  const bumpListRefsGeneration = (gitCommonDir: string): number =>
    setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);
  const listRefsSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsRefreshCacheKey) =>
      Effect.suspend(() => {
        const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);
        return Cache.get(
          listRefsSnapshotCache,
          new GitRefsSnapshotCacheKey({ gitCommonDir: cacheKey.gitCommonDir, epoch }),
        );
      }),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
    },
  );
  const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
    gitCommonDir: string,
    refresh: boolean,
  ) {
    while (true) {
      const generation = currentListRefsGeneration(gitCommonDir);
      const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
      const snapshot =
        refresh || currentEpoch === undefined
          ? // The refresh cache owns the complete snapshot read, rather than only the
            // epoch bump. Slow repositories therefore remain singleflight for the
            // entire Git scan even when more refresh requests arrive after the
            // coalescing TTL would otherwise have elapsed.
            yield* Cache.get(
              listRefsRefreshSnapshotCache,
              new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
            )
          : yield* Cache.get(
              listRefsSnapshotCache,
              new GitRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
            );
      if (currentListRefsGeneration(gitCommonDir) === generation) {
        return snapshot;
      }
    }
  });
  const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
    cwd: string,
  ) {
    const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
    const repositoryPaths = yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey);
    if (repositoryPaths === null) return;
    const previousGeneration = currentListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsGeneration(repositoryPaths.gitCommonDir);
    bumpListRefsEpoch(repositoryPaths.gitCommonDir);
    yield* Cache.invalidate(
      listRefsRefreshSnapshotCache,
      new GitRefsRefreshCacheKey({
        gitCommonDir: repositoryPaths.gitCommonDir,
        generation: previousGeneration,
      }),
    );
    yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
    yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
  });

  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const repositoryPaths = yield* resolveRepositoryPaths(input.cwd, input.refresh === true).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (repositoryPaths === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }

      const snapshot = yield* resolveListRefsSnapshot(
        repositoryPaths.gitCommonDir,
        input.refresh === true,
      );
      const hasCurrentWorktreeBranch =
        repositoryPaths.worktreeRoot !== null &&
        snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);
      const localBranches = snapshot.localBranches.map((ref) => ({
        ...ref,
        current: hasCurrentWorktreeBranch
          ? ref.worktreePath === repositoryPaths.worktreeRoot
          : ref.name === repositoryPaths.currentBranch,
      }));
      const combinedBranches = input.includeMatchingRemoteRefs
        ? [...localBranches, ...snapshot.remoteBranches]
        : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);
      // Keep current/default refs on the first page even when the default
      // only exists as origin/<default> (remote refs sort after all locals).
      const allBranches = combinedBranches.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const branchesForKind =
        input.refKind === "local"
          ? allBranches.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allBranches.filter((ref) => ref.isRemote)
            : allBranches;
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(branchesForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
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
      fallbackErrorDetail: "git worktree add failed",
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    });

    if (input.newRefName && input.baseRefName) {
      const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));
      const parsedBaseRef = parseRemoteRefWithRemoteNames(
        input.baseRefName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
      yield* runGit("GitVcsDriver.createWorktree.configureBaseRef", input.cwd, [
        "config",
        `branch.${input.newRefName}.gh-merge-base`,
        baseBranch,
      ]);
    }

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"] =
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
          fallbackErrorDetail: "git fetch pull request branch failed",
        },
      );
    });

  const resolveCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveCommit"] = Effect.fn(
    "resolveCommit",
  )(function* (input) {
    const commitSha = yield* runGitStdout("GitVcsDriver.resolveCommit", input.cwd, [
      "rev-parse",
      "--verify",
      `${input.revision}^{commit}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const fetchPullRequestHeadCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestHeadCommit"] =
    Effect.fn("fetchPullRequestHeadCommit")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      // No refspec destination: the pull head lands in FETCH_HEAD (per worktree) instead of a
      // branch, which is the only way to read it while that branch is checked out somewhere.
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestHeadCommit",
        input.cwd,
        ["fetch", "--quiet", "--no-tags", remoteName, `refs/pull/${input.prNumber}/head`],
        {
          fallbackErrorDetail: "git fetch pull request head failed",
        },
      );

      return yield* resolveCommit({ cwd: input.cwd, revision: "FETCH_HEAD" });
    });

  const refreshCheckedOutBranch: GitVcsDriver.GitVcsDriver["Service"]["refreshCheckedOutBranch"] =
    Effect.fn("refreshCheckedOutBranch")(function* (input) {
      const { commitSha: headCommit } = yield* resolveCommit({ cwd: input.cwd, revision: "HEAD" });
      if (headCommit === input.targetCommit) {
        return { headCommit, moved: false, onTarget: true };
      }

      const worktreeChanges = yield* runGitStdout(
        "GitVcsDriver.refreshCheckedOutBranch.status",
        input.cwd,
        ["status", "--porcelain"],
      );
      if (worktreeChanges.trim().length > 0) {
        return { headCommit, moved: false, onTarget: false };
      }

      const isAncestor = yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.isAncestor",
        input.cwd,
        ["merge-base", "--is-ancestor", headCommit, input.targetCommit],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      // A rewritten head (rebase, squash, amend) does not descend from the checkout, so it can
      // only be taken by resetting. That is lossless exactly when the tree is clean and HEAD
      // never left the commit the upstream held before the fetch.
      if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
        return { headCommit, moved: false, onTarget: false };
      }

      if (!isAncestor) {
        // The commit being reset away is about to be reachable from nothing. It is only ever a
        // commit the remote already held, but "the remote held it" stops being a way back once
        // the head it belonged to has been rewritten, so a ref keeps it findable.
        yield* executeGit(
          "GitVcsDriver.refreshCheckedOutBranch.keepPrevious",
          input.cwd,
          ["update-ref", "refs/t3code/pre-refresh", headCommit],
          { fallbackErrorDetail: "git failed to record the previous checkout commit" },
        );
      }

      yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.move",
        input.cwd,
        // `--merge` rather than `--hard`: the cleanliness check above is a snapshot, and another
        // thread may edit a tracked file between it and this move. Git itself refuses a `--merge`
        // reset that would overwrite such an edit — the same guarantee `--ff-only` gives the
        // other branch — so a race loses nothing; the refresh fails and is reported instead.
        isAncestor
          ? ["merge", "--ff-only", input.targetCommit]
          : ["reset", "--merge", input.targetCommit],
        {
          timeoutMs: 30_000,
          fallbackErrorDetail: "git failed to move the checkout onto the pull request head",
        },
      );

      return { headCommit: input.targetCommit, moved: true, onTarget: true };
    });

  const fetchRemote: GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"] = Effect.fn("fetchRemote")(
    function* (input) {
      yield* executeGit(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        ["fetch", "--quiet", input.remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
        },
      );
    },
  );

  const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
    Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
      const remoteNames = yield* listRemoteNames(input.cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(
        input.refName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const remoteRefName =
        parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
      const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remoteRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha, remoteRefName };
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
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

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    yield* executeGit("GitVcsDriver.removeWorktree", input.cwd, args, {
      timeoutMs: 15_000,
      fallbackErrorDetail: "git worktree remove failed",
    });
  });

  const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
    "renameBranch",
  )(function* (input) {
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
        fallbackErrorDetail: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
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
        fallbackErrorDetail: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
    cwd,
  ) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) => {
        const branchNames: Array<string> = [];
        for (const line of stdout.split("\n")) {
          const branchName = line.trim();
          if (branchName.length > 0) {
            branchNames.push(branchName);
          }
        }
        return branchNames;
      }),
    );

  const withListRefsInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.ensuring(
        Effect.all([
          invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
          invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
        ]),
      ),
    );
  const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
    input,
  ) =>
    initRepo(input).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
          yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
          yield* Cache.invalidate(repositoryPathsCache, cacheKey);
          yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
        }),
      ),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    prepareCommitContext,
    commit: (cwd, subject, body, options) =>
      withListRefsInvalidation(cwd, commit(cwd, subject, body, options)),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options)),
    pullCurrentBranch: (cwd) => withListRefsInvalidation(cwd, pullCurrentBranch(cwd)),
    readRangeContext,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    readConfigValue,
    listRefs,
    createWorktree: (input) => withListRefsInvalidation(input.cwd, createWorktree(input)),
    fetchPullRequestBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchPullRequestBranch(input)),
    fetchPullRequestHeadCommit,
    resolveCommit,
    refreshCheckedOutBranch: (input) =>
      withListRefsInvalidation(input.cwd, refreshCheckedOutBranch(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    fetchRemote: (input) => withListRefsInvalidation(input.cwd, fetchRemote(input)),
    remoteExists,
    resolveRemoteTrackingCommit,
    fetchRemoteBranch: (input) => withListRefsInvalidation(input.cwd, fetchRemoteBranch(input)),
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    setBranchUpstream: (input) => withListRefsInvalidation(input.cwd, setBranchUpstream(input)),
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    initRepo: initRepoWithListRefsInvalidation,
    listLocalBranchNames,
  });
});
