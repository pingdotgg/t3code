// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingReturnYieldStar:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { DEFAULT_HISTORY_BYTE_LIMIT, DEFAULT_HISTORY_LINE_LIMIT, DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS, DEFAULT_PROCESS_KILL_GRACE_MS, DEFAULT_SUBPROCESS_POLL_INTERVAL_MS, MAX_HISTORY_FILENAME_BYTES, TerminalProcessSignalError, defaultShellResolver, encodedHistoryThreadPart, formatShellCandidate, hashId, isDuplicateAttachSnapshotEvent, isRetryableShellSpawnError, joinHistoryFileName, legacySafeThreadId, nowIso, resolvePosixPsCommand, terminalEventToAttachEvent, toSessionKey } from "./terminalSupport0.ts";
type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;
import type { TerminalManager } from "./Manager.ts";
import { advanceEventSequence, resizePtyProcess, snapshot, summary, terminalActivityMark, terminalWireLabel } from "./terminalSupport2.ts";
import { hashedHistoryThreadPart, posixProcessTableSnapshot, windowsProcessTableSnapshot } from "./terminalSupport1.ts";
import type { QuietTerminalSession, ShellCandidate, TerminalGrid, TerminalViewer } from "./terminalSupport0.ts";
import type { TerminalManagerState } from "./terminalSupport2.ts";
import type { TerminalSessionState } from "./terminalSupport1.ts";

import type { TerminalManagerOptions } from "./terminalSupport2.ts";
export type Deps = { readonly options: TerminalManagerOptions };

export const install0 = Effect.fn("terminalManager.install0")(function* (d: Deps) {
  const { options } = d;
  const fileSystem = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;

  const context = yield* Effect.context<never>();

  const logsDir = options.logsDir;

  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;

  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;

  const platform = yield* HostProcess.Platform;

  const architecture = yield* HostProcess.Architecture;

  const agentScope = yield* AgentScope;
  // Inherit the full environment minus createTerminalSpawnEnv's blocklist; allowlists silently drop user tooling variables.

  const baseEnv = options.env ?? process.env;

  const processRunner = yield* ProcessRunner.ProcessRunner;

  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <Input extends TerminalOpenInput | TerminalAttachInput>(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      if (input.providerInstanceId === undefined) return input;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      }
      const env = yield* resolver(input.providerInstanceId, input.env);
      return { ...input, env };
    },
  );
  // Share one process table per poll; per-terminal scans can exhaust PIDs on busy hosts.
  // Timed on success and failure so the poll loop can pace the next query.

  const customSubprocessInspector = options.subprocessInspector;

  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;

  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;

  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;

  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  // Keep close markers in memory so unknown IDs recover after a server restart.

  const closedSessionKeys = new Set<string>();

  const threadLocks = yield* KeyedLock.make<string>();

  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();

  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const terminalViewers = new Map<string, Map<string, TerminalViewer>>();

  let anonymousViewerCount = 0;

  let quietSessions = new WeakMap<TerminalSessionState, QuietTerminalSession>();

  let skippedQuietTicks = 0;

  const runFork = Effect.runForkWith(context);

  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));

  const posixPsCommand = platform === "win32" ? undefined : yield* resolvePosixPsCommand();

  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const publishEvent =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (event: TerminalEvent) {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const encodedHistoryPath = (threadId: string, terminalId: string) =>
    path.join(
      logsDir,
      joinHistoryFileName(
        encodedHistoryThreadPart(threadId),
        terminalId === DEFAULT_TERMINAL_ID ? null : Base64Url.encode(terminalId),
      ),
    );

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const historyExists = (filePath: string) => {
    const name = path.basename(filePath);
    // An oversized old path can itself fail on access. Directory entries also
    // preserve migration of such histories on filesystems with a larger limit.
    return name.length <= MAX_HISTORY_FILENAME_BYTES
      ? fileSystem.exists(filePath)
      : fileSystem.readDirectory(logsDir).pipe(Effect.map((entries) => entries.includes(name)));
  };

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => threadLocks.withLock(threadId, effect);

  const retainViewer = (sessionKey: string, viewerId: string, grid: TerminalGrid | null) => {
    let viewers = terminalViewers.get(sessionKey);
    if (!viewers) {
      viewers = new Map();
      terminalViewers.set(sessionKey, viewers);
    }
    const viewer = viewers.get(viewerId);
    if (viewer) {
      viewer.streams += 1;
      // After a viewer's first size, resizes own it; attach retries resend the original size.
      viewer.grid ??= grid;
    } else {
      viewers.set(viewerId, { streams: 1, grid });
    }
  };

  /** Returns whether the viewer left, which can grow the shared grid. */

  const releaseViewer = (sessionKey: string, viewerId: string) => {
    const viewers = terminalViewers.get(sessionKey);
    const viewer = viewers?.get(viewerId);
    if (!viewers || !viewer) return false;
    viewer.streams -= 1;
    if (viewer.streams > 0) return false;
    viewers.delete(viewerId);
    if (viewers.size === 0) terminalViewers.delete(sessionKey);
    return true;
  };

  // The smallest attached viewer bounds each axis, so every viewer can draw the whole grid.

  const sharedViewerGrid = (sessionKey: string): TerminalGrid | null => {
    let shared: TerminalGrid | null = null;
    for (const viewer of terminalViewers.get(sessionKey)?.values() ?? []) {
      if (!viewer.grid) continue;
      shared = shared
        ? {
            cols: Math.min(shared.cols, viewer.grid.cols),
            rows: Math.min(shared.rows, viewer.grid.rows),
          }
        : viewer.grid;
    }
    return shared;
  };

  /** Attached viewers own the size; a caller's own size only applies when none has reported one. */

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    // Subscribe before SIGTERM to catch immediate exits; Effect.ensuring releases even on interruption, unlike JS finally.
    const exited = Deferred.makeUnsafe<void>();
    const unsubscribeExit = process.onExit(() => {
      Deferred.doneUnsafe(exited, Effect.void);
    });
    yield* Effect.gen(function* () {
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGTERM",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            cause: error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminated) {
        return;
      }

      const exitedBeforeGrace = yield* Deferred.await(exited).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: processKillGraceMs,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (exitedBeforeGrace) {
        return;
      }

      yield* Effect.try({
        try: () => process.kill("SIGKILL"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGKILL",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            cause: error,
          }),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(unsubscribeExit)));
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadParts = [encodedHistoryThreadPart(threadId), hashedHistoryThreadPart(threadId)];
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${legacySafeThreadId(threadId)}.log` ||
          threadParts.some((part) => name === `${part}.log` || name.startsWith(`${part}_`)),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shell: string; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const launch = yield* agentScope.wrap({
      command: candidate.shell,
      args: candidate.args ?? [],
      name: "terminal",
      env: spawnEnv,
      survivesRestart: true,
    });
    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: launch.command,
        ...(launch.args.length > 0 ? { args: [...launch.args] } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shell: candidate.shell,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const isQuiet = (session: TerminalSessionState & { pid: number }) => {
    const quiet = quietSessions.get(session);
    return (
      quiet !== undefined &&
      quiet.idleSnapshots === 2 &&
      quiet.process === session.process &&
      quiet.mark === terminalActivityMark(session) &&
      !session.hasRunningSubprocess
    );
  };

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener, registerCleanup) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      const stop = () => {
        terminalEventListeners.delete(listener);
      };
      // Transfer ownership before an interrupt can discard the returned handle.
      registerCleanup?.(stop);
      return stop;
    });

  // Subscribe after taking the lock so contention cannot accumulate an unbounded replay.
  // Snapshot listeners run under that lock and must not block.

  const fallbackProcessTableSnapshot = (timeout: Duration.Input) =>
    (posixPsCommand === undefined
      ? windowsProcessTableSnapshot(timeout)
      : posixProcessTableSnapshot(posixPsCommand, timeout)
    ).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.result,
      Effect.timed,
      Effect.map(([elapsed, snapshot]) => ({
        snapshot,
        queryElapsedMs: Duration.toMillis(elapsed),
      })),
    );
  // `fallbackTimeout` only bounds the ps/WMI fallback; a native process table
  // or custom inspector is unaffected.

  const historyPath = (threadId: string, terminalId: string) => {
    const encoded = encodedHistoryPath(threadId, terminalId);
    if (path.basename(encoded).length <= MAX_HISTORY_FILENAME_BYTES) return encoded;
    return path.join(
      logsDir,
      joinHistoryFileName(
        hashedHistoryThreadPart(threadId),
        terminalId === DEFAULT_TERMINAL_ID ? null : hashId(terminalId),
      ),
    );
  };

  const withSharedGrid = <
    A extends { readonly cols?: number | undefined; readonly rows?: number | undefined },
  >(
    sessionKey: string,
    input: A,
  ): A => {
    const shared = sharedViewerGrid(sessionKey);
    return shared ? { ...input, cols: shared.cols, rows: shared.rows } : input;
  };

  // Renderers draw the PTY grid, so every size change reaches them. It rides on activity
  // because older clients reject unknown event types.

  const resizeSession = Effect.fnUntraced(function* (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    cols: number,
    rows: number,
  ) {
    yield* resizePtyProcess(session, process, cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.updatedAt = yield* nowIso;
    const eventStamp = advanceEventSequence(session);
    yield* publishEvent({
      type: "activity",
      threadId: session.threadId,
      terminalId: session.terminalId,
      sequence: eventStamp.sequence,
      hasRunningSubprocess: session.hasRunningSubprocess,
      label: terminalWireLabel(session),
      cols,
      rows,
    });
  });

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      // Children may finalize before registration; check inside the synchronized update to avoid retaining finished fibers.
      if (fiber.pollUnsafe() !== undefined) {
        return [undefined, state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
          closedSessionKeys.add(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const streamSession = (
    input: TerminalObserveInput,
    initial: Effect.Effect<TerminalSessionSnapshot | null, TerminalError>,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    registerCleanup?: (stop: () => void) => void,
  ) => {
    let unsubscribe: (() => void) | null = null;
    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;
      let snapshotFloor: number | null = null;

      yield* subscribe(
        (event) => {
          if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
            return Effect.void;
          }

          if (!deliverLive) {
            bufferedEvents.push(event);
            return Effect.void;
          }

          // Fanout can finish after a snapshot that already includes the event.
          // Keep only its sequence, not its history, until the session changes.
          if (snapshotFloor !== null) {
            if (
              event.type === "started" ||
              event.type === "restarted" ||
              event.type === "error" ||
              event.type === "closed"
            ) {
              snapshotFloor = null;
            } else if (typeof event.sequence === "number" && event.sequence <= snapshotFloor) {
              return Effect.void;
            }
          }

          const attachEvent = terminalEventToAttachEvent(event);
          return listener(attachEvent);
        },
        (cleanup) => {
          unsubscribe = cleanup;
          registerCleanup?.(stop);
        },
      );

      const initialSnapshot = yield* initial;

      yield* listener(
        initialSnapshot === null
          ? { type: "closed", threadId: input.threadId, terminalId: input.terminalId }
          : { type: "snapshot", snapshot: initialSnapshot },
      );

      for (const event of bufferedEvents) {
        if (initialSnapshot !== null && isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        yield* listener(attachEvent);
      }
      // The live listener keeps this closure, so release replayed output.
      bufferedEvents.length = 0;

      snapshotFloor = initialSnapshot?.sequence ?? null;
      deliverLive = true;
      return stop;
    }).pipe(
      (effect) => withThreadLock(input.threadId, effect),
      Effect.onError(() => Effect.sync(stop)),
    );
  };

  /** Retains `viewer` and returns its release, which runs at most once. */
  return {
    options,
    fileSystem,
    path,
    context,
    logsDir,
    historyLineLimit,
    historyByteLimit,
    platform,
    architecture,
    agentScope,
    baseEnv,
    processRunner,
    resolveLaunchInputEnvironment,
    customSubprocessInspector,
    subprocessPollIntervalMs,
    processKillGraceMs,
    maxRetainedInactiveSessions,
    registerTerminalProcesses,
    managerStateRef,
    closedSessionKeys,
    threadLocks,
    terminalEventListeners,
    workerScope,
    terminalViewers,
    anonymousViewerCount,
    quietSessions,
    skippedQuietTicks,
    runFork,
    shellResolver,
    posixPsCommand,
    unregisterTerminal,
    publishEvent,
    encodedHistoryPath,
    legacyHistoryPath,
    historyExists,
    readManagerState,
    modifyManagerState,
    withThreadLock,
    retainViewer,
    releaseViewer,
    sharedViewerGrid,
    runKillEscalation,
    readHistoryTail,
    deleteAllHistoryForThread,
    assertValidCwd,
    trySpawn,
    isQuiet,
    subscribe,
    fallbackProcessTableSnapshot,
    historyPath,
    withSharedGrid,
    resizeSession,
    clearKillFiber,
    registerKillFiber,
    getSession,
    sessionsForThread,
    evictInactiveSessionsIfNeeded,
    hasRunningSessions,
    readAllTerminalMetadata,
    streamSession,
  };
});
