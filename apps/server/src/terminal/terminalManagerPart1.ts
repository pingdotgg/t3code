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
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
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
import { BoundedTerminalHistory, sanitizeTerminalHistoryChunk } from "./terminalSupport1.ts";
import { DEFAULT_PERSIST_DEBOUNCE_MS, TerminalSubprocessCheckError, nowIso, processTableSnapshotFromProcesses, shouldPublishTerminalMetadataEvent, toSessionKey } from "./terminalSupport0.ts";
type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;
import type { TerminalManager } from "./Manager.ts";
import { advanceEventSequence, cleanupProcessHandles, deriveSubprocessInspectResult, snapshot, summary } from "./terminalSupport2.ts";
import type { DrainProcessEventAction, PersistHistoryRequest, TerminalSessionState } from "./terminalSupport1.ts";
import type { TerminalGrid, TerminalProcessTableSnapshot, TerminalSubprocessInspector } from "./terminalSupport0.ts";
import { install0 } from "./terminalManagerPart0.ts";

export type Deps = SuccessOf<typeof install0>;

export const install1 = Effect.fn("terminalManager.install1")(function* (d: Deps) {
  const { clearKillFiber, customSubprocessInspector, encodedHistoryPath, evictInactiveSessionsIfNeeded, fallbackProcessTableSnapshot, fileSystem, getSession, historyByteLimit, historyExists, historyLineLimit, historyPath, legacyHistoryPath, logsDir, modifyManagerState, platform, publishEvent, readHistoryTail, registerKillFiber, releaseViewer, resizeSession, retainViewer, runFork, runKillEscalation, sharedViewerGrid, streamSession, terminalViewers, unregisterTerminal, withThreadLock, workerScope, options } = d;
  const fetchProcessTableSnapshot = (
    fallbackTimeout: Duration.Input,
  ): Effect.Effect<{
    readonly snapshot: Result.Result<TerminalProcessTableSnapshot, TerminalSubprocessCheckError>;
    readonly snapshotSucceeded: boolean;
    readonly queryElapsedMs: number;
  }> =>
    options.processTable
      ? options.processTable.pipe(
          Effect.map((entries) => ({
            snapshot: Result.succeed(processTableSnapshotFromProcesses(entries)),
            snapshotSucceeded: true,
            queryElapsedMs: 0,
          })),
          Effect.catch(() =>
            fallbackProcessTableSnapshot(fallbackTimeout).pipe(
              Effect.map((fallback) => ({ ...fallback, snapshotSucceeded: false })),
            ),
          ),
        )
      : fallbackProcessTableSnapshot(fallbackTimeout).pipe(
          Effect.map((fallback) => ({
            ...fallback,
            snapshotSucceeded: Result.isSuccess(fallback.snapshot),
          })),
        );

  const historyPaths = (threadId: string, terminalId: string) => [
    ...new Set([
      historyPath(threadId, terminalId),
      encodedHistoryPath(threadId, terminalId),
      ...(terminalId === DEFAULT_TERMINAL_ID ? [legacyHistoryPath(threadId)] : []),
    ]),
  ];

  const applySharedGrid = Effect.fnUntraced(function* (threadId: string, terminalId: string) {
    const session = yield* getSession(threadId, terminalId);
    if (Option.isNone(session)) return;
    const process = session.value.process;
    const shared = sharedViewerGrid(toSessionKey(threadId, terminalId));
    if (
      !process ||
      session.value.status !== "running" ||
      !shared ||
      (shared.cols === session.value.cols && shared.rows === session.value.rows)
    ) {
      return;
    }
    yield* resizeSession(session.value, process, shared.cols, shared.rows);
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem
        .writeFileString(historyPath(threadId, terminalId), request.history.value())
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
    }),
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Effect.fromOption(session, () => new TerminalSessionLookupError({ threadId, terminalId })),
    );
  });

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const resyncStream: TerminalManager["Service"]["resyncStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      getSession(input.threadId, input.terminalId).pipe(
        Effect.map((session) => (Option.isSome(session) ? snapshot(session.value) : null)),
      ),
      listener,
      registerCleanup,
    );

  const acquireSubprocessInspector = (
    fallbackTimeout: Duration.Input,
  ): Effect.Effect<{
    readonly inspector: Result.Result<TerminalSubprocessInspector, TerminalSubprocessCheckError>;
    readonly snapshotSucceeded: boolean;
    readonly queryElapsedMs: number;
  }> =>
    customSubprocessInspector !== undefined
      ? Effect.succeed({
          inspector: Result.succeed(customSubprocessInspector),
          snapshotSucceeded: true,
          queryElapsedMs: 0,
        })
      : Effect.map(
          fetchProcessTableSnapshot(fallbackTimeout),
          ({ snapshot, snapshotSucceeded, queryElapsedMs }) => ({
            inspector: Result.map(
              snapshot,
              (table): TerminalSubprocessInspector =>
                (terminalPid) =>
                  Effect.succeed(deriveSubprocessInspectResult(table, terminalPid, platform)),
            ),
            snapshotSucceeded,
            queryElapsedMs,
          }),
        );

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    for (const sourcePath of historyPaths(threadId, terminalId)) {
      const migrating = sourcePath !== nextPath;
      const operation = migrating ? "migrate" : "read";
      if (
        !(yield* historyExists(sourcePath).pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation, threadId, terminalId, cause }),
          ),
        ))
      )
        continue;
      const { history: raw, truncated } = yield* readHistoryTail(sourcePath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation, threadId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (migrating || truncated || capped !== raw) {
        const write = migrating
          ? Effect.gen(function* () {
              const temporaryPath = yield* fileSystem.makeTempFileScoped({
                directory: logsDir,
                prefix: ".history-",
              });
              yield* fileSystem.writeFileString(temporaryPath, capped);
              yield* fileSystem.rename(temporaryPath, nextPath);
            }).pipe(Effect.scoped)
          : fileSystem.writeFileString(nextPath, capped);
        yield* write.pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({
                operation: migrating ? "migrate" : "truncate",
                threadId,
                terminalId,
                cause,
              }),
          ),
        );
      }
      if (migrating) {
        yield* fileSystem.remove(sourcePath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to remove legacy terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }
      return history;
    }
    return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* Effect.forEach(
      historyPaths(threadId, terminalId),
      (filePath) =>
        Effect.gen(function* () {
          if (yield* historyExists(filePath)) {
            yield* fileSystem.remove(filePath, { force: true });
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const getShell = Effect.fn("terminal.getShell")(function* (input: TerminalObserveInput) {
    const session = yield* requireSession(input.threadId, input.terminalId);
    if (session.status !== "running" || session.shell === null) {
      return yield* new TerminalNotRunningError(input);
    }
    return session.shell;
  });

  const retainViewerOnce = (
    input: TerminalObserveInput,
    viewer: string,
    grid: TerminalGrid | null,
  ) => {
    const sessionKey = toSessionKey(input.threadId, input.terminalId);
    retainViewer(sessionKey, viewer, grid);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      if (releaseViewer(sessionKey, viewer)) {
        runFork(withThreadLock(input.threadId, applySharedGrid(input.threadId, input.terminalId)));
      }
    };
  };

  const observeStream: TerminalManager["Service"]["observeStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      requireSession(input.threadId, input.terminalId).pipe(Effect.map(snapshot)),
      listener,
      registerCleanup,
    );

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    session.inputCount += 1;
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (
    input: TerminalResizeInput,
    viewerId: string | undefined,
  ) {
    const sessionKey = toSessionKey(input.threadId, input.terminalId);
    const viewer =
      viewerId === undefined ? undefined : terminalViewers.get(sessionKey)?.get(viewerId);
    if (viewer) {
      viewer.grid = { cols: input.cols, rows: input.rows };
      return yield* applySharedGrid(input.threadId, input.terminalId);
    }
    // A caller that is not attached cannot override the viewers that are.
    if (sharedViewerGrid(sessionKey)) return;
    const session = yield* getSession(input.threadId, input.terminalId);
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (
      !process ||
      session.value.status !== "running" ||
      (session.value.cols === input.cols && session.value.rows === input.rows)
    ) {
      return;
    }
    yield* resizeSession(session.value, process, input.cols, input.rows);
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEvents[session.pendingProcessEventIndex] = undefined;
        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex * 2 >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = session.pendingProcessEvents.slice(
            session.pendingProcessEventIndex,
          );
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });
  return {
    fetchProcessTableSnapshot,
    historyPaths,
    applySharedGrid,
    startKillEscalation,
    persistWorker,
    requireSession,
    readTerminalMetadata,
    resyncStream,
    acquireSubprocessInspector,
    queuePersist,
    flushPersist,
    readHistory,
    deleteHistory,
    stopProcess,
    getShell,
    retainViewerOnce,
    observeStream,
    metadataEventFromTerminalEvent,
    write,
    resizeLocked,
    persistHistory,
    drainProcessEvents,
  };
});
