// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingReturnYieldStar:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
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
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { CLOSE_IDLE_QUERY_TIMEOUT, toSessionKey } from "./terminalSupport0.ts";
type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;
import type { TerminalManager } from "./Manager.ts";
import { snapshot, terminalActivityMark } from "./terminalSupport2.ts";
import type { TerminalSessionState } from "./terminalSupport1.ts";
import { install0 } from "./terminalManagerPart0.ts";
import { install1 } from "./terminalManagerPart1.ts";
import { install2 } from "./terminalManagerPart2.ts";

export type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1> & SuccessOf<typeof install2>;

export const install3 = Effect.fn("terminalManager.install3")(function* (d: Deps) {
  const { acquireSubprocessInspector, anonymousViewerCount, closeSession, closedSessionKeys, deleteAllHistoryForThread, getSession, openWithWorkspaceLease, path, platform, resizeSession, resolveLaunchInputEnvironment, resyncStream, retainViewerOnce, sessionsForThread, streamSession, withSharedGrid, withThreadLock } = d;
  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  const closeIdle: TerminalManager["Service"]["closeIdle"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const running = (yield* sessionsForThread(input.threadId)).filter(
          (session): session is TerminalSessionState & { pid: number } =>
            session.status === "running" &&
            Number.isInteger(session.pid) &&
            (input.terminalId === undefined || session.terminalId === input.terminalId),
        );
        if (running.length === 0) return;
        const marks = new Map(
          running.map((session) => [session.terminalId, terminalActivityMark(session)]),
        );
        // Inspect now so commands started after the last poll still protect their terminals.
        const { inspector: inspectorResult } = yield* acquireSubprocessInspector(
          platform === "win32" ? CLOSE_IDLE_QUERY_TIMEOUT.win32 : CLOSE_IDLE_QUERY_TIMEOUT.posix,
        );
        const inspector = yield* Effect.fromResult(inspectorResult);
        yield* Effect.forEach(
          running,
          (session) =>
            inspector(session.pid).pipe(
              Effect.flatMap((result) =>
                result.hasRunningSubprocess ||
                terminalActivityMark(session) !== marks.get(session.terminalId)
                  ? Effect.void
                  : closeSession(input.threadId, session.terminalId, false),
              ),
            ),
          { discard: true },
        );
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to close idle terminals", {
          threadId: input.threadId,
          error: error.message,
        }),
      ),
    );

  const openLocked = (input: TerminalOpenInput) =>
    withWorkspaceLease(
      path.resolve(input.worktreePath ?? input.cwd),
      openWithWorkspaceLease(input),
    );

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(openLocked)),
    );

  const openOrAttachForStream = Effect.fnUntraced(function* (requestedInput: TerminalAttachInput) {
    const terminalId = requestedInput.terminalId;
    const input = withSharedGrid(toSessionKey(requestedInput.threadId, terminalId), requestedInput);
    const existing = yield* getSession(input.threadId, terminalId);

    if (Option.isNone(existing)) {
      if (input.resume && closedSessionKeys.has(toSessionKey(input.threadId, terminalId))) {
        return null;
      }
      if (!input.cwd) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId,
        });
      }

      const resolvedInput = yield* resolveLaunchInputEnvironment({
        ...input,
        terminalId,
        cwd: input.cwd,
      });
      return yield* Effect.uninterruptible(openLocked(resolvedInput));
    }

    const session = existing.value;
    const targetCols = input.cols ?? session.cols;
    const targetRows = input.rows ?? session.rows;

    if (!input.resume && !session.process && input.cwd && input.restartIfNotRunning === true) {
      const resolvedInput = yield* resolveLaunchInputEnvironment({
        ...input,
        terminalId,
        cwd: input.cwd,
      });
      return yield* Effect.uninterruptible(openLocked(resolvedInput));
    }

    if (
      session.process &&
      session.status === "running" &&
      (session.cols !== targetCols || session.rows !== targetRows)
    ) {
      yield* resizeSession(session, session.process, targetCols, targetRows);
    }

    return snapshot(session);
  });

  const attachStream: TerminalManager["Service"]["attachStream"] = (
    input,
    listener,
    registerCleanup,
    viewerId,
  ) => {
    const viewer = viewerId ?? `stream:${++d.anonymousViewerCount}`;
    let detach = () => {};
    const initial = Effect.suspend(() => {
      detach = retainViewerOnce(
        input,
        viewer,
        input.cols !== undefined && input.rows !== undefined
          ? { cols: input.cols, rows: input.rows }
          : null,
      );
      return openOrAttachForStream(input);
    });
    return streamSession(
      input,
      initial,
      listener,
      registerCleanup &&
        ((stop) =>
          registerCleanup(() => {
            stop();
            detach();
          })),
    ).pipe(
      Effect.map((stop) => () => {
        stop();
        detach();
      }),
      Effect.onError(() => Effect.sync(detach)),
    );
  };

  const attachOutputStream: TerminalManager["Service"]["attachOutputStream"] = (input, viewerId) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => retainViewerOnce(input, viewerId, null)),
        (release) => Effect.sync(release),
      ).pipe(
        Effect.as(
          terminalOutputStream(
            (listener, registerCleanup) => attachStream(input, listener, registerCleanup, viewerId),
            (listener, registerCleanup) => resyncStream(input, listener, registerCleanup),
          ),
        ),
      ),
    );
  return {
    close,
    closeIdle,
    openLocked,
    open,
    openOrAttachForStream,
    attachStream,
    attachOutputStream,
  };
});
