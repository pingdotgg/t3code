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
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";

import { acpRegistryManagedBinaryDirectories } from "@t3tools/provider-acp-registry/server";
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
import { increment, terminalSessionsTotal } from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { BoundedTerminalHistory, createTerminalSpawnEnv, neutralizeInheritedHistory } from "./terminalSupport1.ts";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS, PROCESS_TABLE_QUERY_TIMEOUT, QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS, normalizedRuntimeEnv, nowIso, subprocessSnapshotPollDelayMs, toSessionKey } from "./terminalSupport0.ts";
type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;
import type { TerminalManager } from "./Manager.ts";
import { advanceEventSequence, cleanupProcessHandles, enqueueProcessEvent, resolveShellCandidates, snapshot, terminalActivityMark, terminalWireLabel } from "./terminalSupport2.ts";
import type { TerminalSessionState } from "./terminalSupport1.ts";
import type { TerminalStartInput, TerminalSubprocessInspectResult } from "./terminalSupport0.ts";
import { install0 } from "./terminalManagerPart0.ts";
import { install1 } from "./terminalManagerPart1.ts";

export type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1>;

export const install2 = Effect.fn("terminalManager.install2")(function* (d: Deps) {
  const { acquireSubprocessInspector, architecture, assertValidCwd, baseEnv, clearKillFiber, closedSessionKeys, deleteHistory, drainProcessEvents, evictInactiveSessionsIfNeeded, fileSystem, flushPersist, getSession, hasRunningSessions, historyByteLimit, historyLineLimit, isQuiet, metadataEventFromTerminalEvent, modifyManagerState, path, persistHistory, platform, publishEvent, quietSessions, readAllTerminalMetadata, readHistory, readManagerState, registerTerminalProcesses, requireSession, resizeLocked, resizeSession, runFork, runKillEscalation, shellResolver, skippedQuietTicks, startKillEscalation, stopProcess, subprocessPollIntervalMs, subscribe, trySpawn, unregisterTerminal, withSharedGrid, withThreadLock, workerScope, options } = d;
  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()]
      .filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      )
      .map((session) => ({
        session,
        terminalPid: session.pid,
        process: session.process,
        mark: terminalActivityMark(session),
      }));

    if (runningSessions.length === 0) {
      return { snapshotSucceeded: true, queryElapsedMs: 0 };
    }
    if (
      runningSessions.every(({ session }) => isQuiet(session)) &&
      d.skippedQuietTicks < QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS - 1
    ) {
      d.skippedQuietTicks += 1;
      return { snapshotSucceeded: true, queryElapsedMs: 0 };
    }
    d.skippedQuietTicks = 0;

    const { inspector, snapshotSucceeded, queryElapsedMs } = yield* acquireSubprocessInspector(
      PROCESS_TABLE_QUERY_TIMEOUT,
    );
    if (Result.isFailure(inspector)) {
      yield* Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
        reason: inspector.failure,
      });
      d.quietSessions = new WeakMap();
      return { snapshotSucceeded: false, queryElapsedMs };
    }

    const subprocessInspector = inspector.success;
    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      candidate: (typeof runningSessions)[number],
    ) {
      const { session, terminalPid, process } = candidate;
      let mark = candidate.mark;
      const previous = d.quietSessions.get(session);
      d.quietSessions.delete(session);
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.asSome,
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (
        Option.isNone(inspectResult) ||
        session.status !== "running" ||
        session.pid !== terminalPid ||
        session.process !== process
      ) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value !== session ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          liveSession.value.process !== process ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);
        // Only this poll's own event may advance the mark without waking it.
        mark += 1;

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }

      if (
        snapshotSucceeded &&
        !next.hasRunningSubprocess &&
        session.status === "running" &&
        session.pid === terminalPid &&
        session.process === process &&
        terminalActivityMark(session) === mark
      ) {
        d.quietSessions.set(session, {
          process,
          mark,
          idleSnapshots: previous?.process === process && previous.mark === mark ? 2 : 1,
        });
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });

    return { snapshotSucceeded, queryElapsedMs };
  });

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const resize: TerminalManager["Service"]["resize"] = (input, viewerId) =>
    withThreadLock(input.threadId, resizeLocked(input, viewerId));

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.shell = null;
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(
              baseEnv,
              session.runtimeEnv,
              platform,
              yield* HostProcess.HomeDirectory,
            );
            // Append managed install directories so agent commands resolve without shadowing user/system tools.
            if (
              options.managedBinaryCacheDir !== undefined &&
              options.managedBinaryToolsDir !== undefined
            ) {
              const managedDirectories = yield* acpRegistryManagedBinaryDirectories({
                cacheDir: options.managedBinaryCacheDir,
                toolsDir: options.managedBinaryToolsDir,
                platform,
                architecture,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              );
              if (managedDirectories.length > 0) {
                const delimiter = platform === "win32" ? ";" : ":";
                const pathKey =
                  platform === "win32"
                    ? (Object.keys(terminalEnv).find(
                        (candidate) => candidate.toLowerCase() === "path",
                      ) ?? "PATH")
                    : "PATH";
                const merged = mergePathEntries(
                  terminalEnv[pathKey],
                  managedDirectories.join(delimiter),
                  platform,
                );
                if (merged !== undefined) {
                  terminalEnv[pathKey] = merged;
                }
              }
            }
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            let eventsActivated = false;

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.shell = spawnResult.shell;
              session.pid = processPid;
              session.status = "running";
              // onExit may replay an exit immediately; accept it before subscribing.
              session.unsubscribeData = spawnResult.process.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              session.unsubscribeExit = spawnResult.process.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
            // Publish startup before draining any events replayed during subscription.
            eventsActivated = true;
            if (session.processEventDrainRunning) runFork(drainProcessEvents(session, processPid));
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      closedSessionKeys.add(key);
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  // Two unchanged snapshots cover children forked just after the first snapshot.
  // Process identity prevents a restarted shell from inheriting quiet state.

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(({ snapshotSucceeded, queryElapsedMs }) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                  queryElapsedMs,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.threadId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        session.history.clear();
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const openWithWorkspaceLease = Effect.fn("terminal.openLocked")(function* (
    requestedInput: TerminalOpenInput,
  ) {
    const terminalId = requestedInput.terminalId;
    yield* assertValidCwd(requestedInput.cwd);

    const sessionKey = toSessionKey(requestedInput.threadId, terminalId);
    const input = withSharedGrid(sessionKey, requestedInput);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const inherited = yield* readHistory(input.threadId, terminalId);
      const history = new BoundedTerminalHistory(
        historyLineLimit,
        neutralizeInheritedHistory(
          inherited.value(),
          historyLineLimit,
          Math.min(historyByteLimit, DEFAULT_MAX_TERMINAL_BUFFER_BYTES),
        ),
        historyByteLimit,
      );
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
        cols,
        rows,
        process: null,
        shell: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        closedSessionKeys.delete(sessionKey);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
        },
        "started",
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizeSession(liveSession, liveSession.process, targetCols, targetRows);
    }

    return snapshot(liveSession);
  });
  return {
    pollSubprocessActivity,
    offerMetadataEvent,
    resize,
    startSession,
    closeSession,
    subprocessSnapshotFailureCount,
    subscribeMetadata,
    clear,
    openWithWorkspaceLease,
  };
});
