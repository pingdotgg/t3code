/**
 * AetherTerminalManager — the terminal RPC surface for threads backed by the
 * Aether cloud provider, attaching a shell INSIDE the task's cloud VM over its
 * own tab-scoped workspace socket (see `provider/Layers/aether/terminalConnection`).
 *
 * It is a sibling of the local `TerminalManager`, not a replacement: the ws
 * terminal router dispatches per thread (`handles`) so cloud threads get a VM
 * shell while local threads keep their local PTY. Only cloud-relevant surface
 * is implemented — no local pid/shell/cwd/subprocess concepts exist for a
 * remote PTY. Each session owns one connection under a `CloseableScope`;
 * closing the tab (or the session) tears the shell + socket down.
 *
 * Ordering guarantee: a per-session lock serializes "append history + deliver
 * live output" (the drain fiber) against "register listener + emit snapshot"
 * (attach), so a freshly attached client always sees the snapshot first and
 * then every subsequent byte exactly once, in order.
 *
 * @module terminal/AetherTerminalManager
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  ProviderDriverKind,
  ThreadId,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalError,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";

import type { CloudTerminalConnection } from "../provider/CloudTerminalConnector.ts";
import { parseAetherResume } from "../provider/Layers/AetherAdapter.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

const AETHER_DRIVER_KIND = ProviderDriverKind.make("aether");
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Scrollback cap replayed to a (re)attaching client — bytes, not lines. */
const MAX_HISTORY_BYTES = 256 * 1024;

type Listener = (event: TerminalAttachStreamEvent) => Effect.Effect<void>;

type IngressEvent =
  | { readonly _tag: "output"; readonly data: string }
  | { readonly _tag: "closed"; readonly reason: string };

interface AetherTerminalSession {
  readonly threadId: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly lock: Semaphore.Semaphore;
  readonly listeners: Set<Listener>;
  status: TerminalSessionStatus;
  history: string;
  cols: number;
  rows: number;
  sequence: number;
  updatedAt: string;
  connection: CloudTerminalConnection | null;
  scope: Scope.Closeable | null;
  /** Last connect-failure message, re-emitted to a listener that attaches after the failure. */
  errorMessage: string | null;
}

export class AetherTerminalManager extends Context.Service<
  AetherTerminalManager,
  {
    /** Whether this thread's shell should run in the Aether cloud VM. */
    readonly handles: (threadId: string) => Effect.Effect<boolean, TerminalError>;
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: Listener,
    ) => Effect.Effect<() => void, TerminalError>;
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/AetherTerminalManager") {}

const SESSION_KEY_SEPARATOR = " ";
const sessionKey = (threadId: string, terminalId: string): string =>
  `${threadId}${SESSION_KEY_SEPARATOR}${terminalId}`;
const threadKeyPrefix = (threadId: string): string => `${threadId}${SESSION_KEY_SEPARATOR}`;

const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());

const capHistory = (history: string): string =>
  history.length > MAX_HISTORY_BYTES ? history.slice(history.length - MAX_HISTORY_BYTES) : history;

const labelForTerminal = (terminalId: string): string => {
  const match = /^term-(\d+)$/.exec(terminalId);
  return match ? `Terminal ${match[1]}` : terminalId;
};

const snapshotOf = (session: AetherTerminalSession): TerminalSessionSnapshot => ({
  threadId: session.threadId,
  terminalId: session.terminalId,
  cwd: session.cwd,
  worktreePath: null,
  status: session.status,
  pid: null,
  history: session.history,
  exitCode: null,
  exitSignal: null,
  label: labelForTerminal(session.terminalId),
  updatedAt: session.updatedAt,
  sequence: session.sequence,
});

const summaryOf = (session: AetherTerminalSession): TerminalSummary => ({
  threadId: session.threadId,
  terminalId: session.terminalId,
  cwd: session.cwd,
  worktreePath: null,
  status: session.status,
  pid: null,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: labelForTerminal(session.terminalId),
  updatedAt: session.updatedAt,
});

const resolveDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const make = Effect.fn("AetherTerminalManager.make")(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  // The manager's own (app-lifetime) scope. Used to close a session's
  // connection scope from inside its drain fiber without self-interrupt: the
  // drain lives in the session scope, so the close must run on a fiber that
  // does not.
  const managerScope = yield* Effect.scope;

  const sessions = new Map<string, AetherTerminalSession>();
  // Provider binding is immutable per thread, so a routing decision caches
  // forever — keeps per-keystroke `write` off the persistence layer.
  const routingCache = new Map<string, boolean>();

  const deliver = (session: AetherTerminalSession, event: TerminalAttachStreamEvent) =>
    session.lock.withPermits(1)(
      Effect.forEach(Array.from(session.listeners), (listener) => listener(event), {
        discard: true,
      }),
    );

  // Cross-thread terminal list. Aether sessions publish upsert/remove here; the
  // ws router folds this stream into the local manager's metadata so cloud
  // terminals appear alongside local ones.
  const metadataListeners = new Set<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>>();
  const emitMetadata = (event: TerminalMetadataStreamEvent) =>
    Effect.forEach(Array.from(metadataListeners), (listener) => listener(event), { discard: true });
  const emitUpsert = (session: AetherTerminalSession) =>
    emitMetadata({ type: "upsert", terminal: summaryOf(session) });

  const drainLoop = (
    session: AetherTerminalSession,
    ingress: Queue.Queue<IngressEvent>,
  ): Effect.Effect<void> => {
    const step = Queue.take(ingress).pipe(
      Effect.flatMap((event) =>
        session.lock.withPermits(1)(
          Effect.gen(function* () {
            if (event._tag === "output") {
              session.history = capHistory(session.history + event.data);
              session.sequence += 1;
              session.updatedAt = nowIso();
              const wire: TerminalAttachStreamEvent = {
                type: "output",
                threadId: session.threadId,
                terminalId: session.terminalId,
                sequence: session.sequence,
                data: event.data,
              };
              yield* Effect.forEach(Array.from(session.listeners), (listener) => listener(wire), {
                discard: true,
              });
              return true;
            }
            if (session.status !== "exited" && session.status !== "error") {
              session.status = "exited";
              session.connection = null;
              const exitedScope = session.scope;
              session.scope = null;
              session.sequence += 1;
              session.updatedAt = nowIso();
              const wire: TerminalAttachStreamEvent = {
                type: "exited",
                threadId: session.threadId,
                terminalId: session.terminalId,
                sequence: session.sequence,
                exitCode: null,
                exitSignal: null,
              };
              yield* Effect.forEach(Array.from(session.listeners), (listener) => listener(wire), {
                discard: true,
              });
              yield* emitUpsert(session);
              // The shell is gone: free the workspace socket now instead of
              // holding it until the tab closes. Fork the close onto the
              // manager scope — this drain fiber lives in `exitedScope`, so
              // closing it inline would interrupt the close itself.
              if (exitedScope) {
                yield* Scope.close(exitedScope, Exit.void).pipe(Effect.forkIn(managerScope));
              }
            }
            return false;
          }),
        ),
      ),
    );
    return step.pipe(
      Effect.flatMap((keepGoing) => (keepGoing ? drainLoop(session, ingress) : Effect.void)),
    );
  };

  const resolveAetherTask = (threadId: string) =>
    Effect.gen(function* () {
      const bindingOption = yield* directory.getBinding(ThreadId.make(threadId));
      const binding = Option.getOrUndefined(bindingOption);
      if (!binding || binding.provider !== AETHER_DRIVER_KIND) {
        return yield* Effect.die(
          new Error(`AetherTerminalManager routed a non-Aether thread '${threadId}'.`),
        );
      }
      const instanceId = binding.providerInstanceId;
      if (instanceId === undefined || instanceId === null) {
        return {
          _tag: "unavailable",
          reason: "the thread has no provider instance binding.",
        } as const;
      }
      const cursor = parseAetherResume(binding.resumeCursor);
      if (cursor === undefined) {
        return {
          _tag: "unavailable",
          reason: "this thread has no cloud task yet — run a turn before opening a terminal.",
        } as const;
      }
      return { _tag: "ready", instanceId, taskId: cursor.taskId } as const;
    });

  const teardownConnection = (session: AetherTerminalSession) =>
    Effect.gen(function* () {
      const scope = session.scope;
      session.connection = null;
      session.scope = null;
      if (scope) {
        yield* Scope.close(scope, Exit.void);
      }
    });

  // On manager/app shutdown, close every open session's connection scope so no
  // VM socket leaks. Session scopes are standalone (Scope.make), so nothing
  // else reaps them.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(sessions.values()), teardownConnection, { discard: true }),
  );

  /** Establish (or re-establish) the VM shell for a session; loud failures become error events. */
  const establishConnection = (session: AetherTerminalSession) =>
    Effect.gen(function* () {
      const resolved = yield* resolveAetherTask(session.threadId);
      if (resolved._tag === "unavailable") {
        return yield* Effect.fail(resolved.reason);
      }
      const adapter = yield* registry.getByInstance(resolved.instanceId);
      const connector = adapter.cloudTerminal;
      if (connector === undefined) {
        return yield* Effect.fail(
          "this Aether instance cannot open a cloud terminal — set AETHER_API_KEY on the provider instance.",
        );
      }
      const scope = yield* Scope.make();
      session.scope = scope;
      // Fresh ingress per connection: a torn-down connection's in-flight
      // frames must never bleed into a later one (e.g. after restart).
      const ingress = yield* Queue.unbounded<IngressEvent>();
      yield* drainLoop(session, ingress).pipe(Effect.forkIn(scope));
      const connection = yield* connector
        .openConnection({
          taskId: resolved.taskId,
          sessionId: session.sessionId,
          cols: session.cols,
          rows: session.rows,
          onOutput: (data) => {
            Queue.offerUnsafe(ingress, { _tag: "output", data });
          },
          onClosed: (reason) => {
            Queue.offerUnsafe(ingress, { _tag: "closed", reason });
          },
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((error) => error.message),
        );
      session.connection = connection;
      session.status = "running";
      session.errorMessage = null;
      session.updatedAt = nowIso();
      yield* emitUpsert(session);
    }).pipe(
      Effect.catch((reason) =>
        Effect.gen(function* () {
          yield* teardownConnection(session);
          const message = typeof reason === "string" ? reason : resolveDetail(reason);
          session.status = "error";
          session.errorMessage = message;
          session.sequence += 1;
          session.updatedAt = nowIso();
          yield* deliver(session, {
            type: "error",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: session.sequence,
            message,
          });
          yield* emitUpsert(session);
        }),
      ),
    );

  const createSession = (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }) =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const session: AetherTerminalSession = {
        threadId: input.threadId,
        terminalId: input.terminalId,
        sessionId: input.terminalId,
        cwd: input.cwd,
        lock,
        listeners: new Set(),
        status: "starting",
        history: "",
        cols: input.cols,
        rows: input.rows,
        sequence: 0,
        updatedAt: nowIso(),
        connection: null,
        scope: null,
        errorMessage: null,
      };
      sessions.set(sessionKey(input.threadId, input.terminalId), session);
      yield* establishConnection(session);
      return session;
    });

  const open: AetherTerminalManager["Service"]["open"] = (input) =>
    Effect.gen(function* () {
      const key = sessionKey(input.threadId, input.terminalId);
      const cols = input.cols ?? DEFAULT_COLS;
      const rows = input.rows ?? DEFAULT_ROWS;
      const existing = sessions.get(key);
      if (existing && existing.connection && existing.status === "running") {
        if (existing.cols !== cols || existing.rows !== rows) {
          existing.cols = cols;
          existing.rows = rows;
          yield* existing.connection.resize(cols, rows).pipe(
            Effect.mapError(
              (cause) =>
                new TerminalResizeError({
                  threadId: input.threadId,
                  terminalId: input.terminalId,
                  terminalPid: 0,
                  cols,
                  rows,
                  cause,
                }),
            ),
          );
        }
        return snapshotOf(existing);
      }
      if (existing) {
        yield* teardownConnection(existing);
        existing.status = "starting";
        existing.history = "";
        existing.cols = cols;
        existing.rows = rows;
        yield* establishConnection(existing);
        return snapshotOf(existing);
      }
      const session = yield* createSession({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        cols,
        rows,
      });
      return snapshotOf(session);
    });

  const attachStream: AetherTerminalManager["Service"]["attachStream"] = (input, listener) =>
    Effect.gen(function* () {
      const key = sessionKey(input.threadId, input.terminalId);
      let session = sessions.get(key);
      if (!session) {
        if (input.cwd === undefined) {
          return yield* new TerminalSessionLookupError({
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
        }
        yield* open({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          ...(input.cols !== undefined ? { cols: input.cols } : {}),
          ...(input.rows !== undefined ? { rows: input.rows } : {}),
        });
        session = sessions.get(key);
      } else if (
        !session.connection &&
        input.restartIfNotRunning === true &&
        input.cwd !== undefined
      ) {
        yield* open({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          ...(input.cols !== undefined ? { cols: input.cols } : {}),
          ...(input.rows !== undefined ? { rows: input.rows } : {}),
        });
        session = sessions.get(key);
      }
      if (!session) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      const target = session;
      // Register + snapshot atomically against the drain: the listener is
      // added and the snapshot captured under the lock, so no output is
      // delivered before the snapshot or dropped between the two.
      yield* target.lock.withPermits(1)(
        Effect.gen(function* () {
          target.listeners.add(listener);
          yield* listener({ type: "snapshot", snapshot: snapshotOf(target) });
          // Re-surface a connect failure that happened before this listener
          // attached (open → error → attach): the snapshot carries status but
          // not the message, so replay it as an error event.
          if (target.status === "error" && target.errorMessage !== null) {
            yield* listener({
              type: "error",
              threadId: target.threadId,
              terminalId: target.terminalId,
              sequence: target.sequence,
              message: target.errorMessage,
            });
          }
        }),
      );
      return () => {
        target.listeners.delete(listener);
      };
    });

  const write: AetherTerminalManager["Service"]["write"] = (input) =>
    Effect.gen(function* () {
      const session = sessions.get(sessionKey(input.threadId, input.terminalId));
      if (!session || !session.connection) {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      yield* session.connection.write(input.data).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalWriteError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              terminalPid: 0,
              cause,
            }),
        ),
      );
    });

  const resize: AetherTerminalManager["Service"]["resize"] = (input) =>
    Effect.gen(function* () {
      const session = sessions.get(sessionKey(input.threadId, input.terminalId));
      if (!session || !session.connection) {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      session.cols = input.cols;
      session.rows = input.rows;
      yield* session.connection.resize(input.cols, input.rows).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalResizeError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              terminalPid: 0,
              cols: input.cols,
              rows: input.rows,
              cause,
            }),
        ),
      );
    });

  const closeOne = (session: AetherTerminalSession) =>
    Effect.gen(function* () {
      session.sequence += 1;
      yield* deliver(session, {
        type: "closed",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.sequence,
      });
      yield* emitMetadata({
        type: "remove",
        threadId: session.threadId,
        terminalId: session.terminalId,
      });
      yield* teardownConnection(session);
    });

  const close: AetherTerminalManager["Service"]["close"] = (input) =>
    Effect.gen(function* () {
      const keys =
        input.terminalId !== undefined
          ? [sessionKey(input.threadId, input.terminalId)]
          : Array.from(sessions.keys()).filter((key) =>
              key.startsWith(threadKeyPrefix(input.threadId)),
            );
      for (const key of keys) {
        const session = sessions.get(key);
        if (!session) continue;
        sessions.delete(key);
        yield* closeOne(session);
      }
    });

  const clear: AetherTerminalManager["Service"]["clear"] = (input) =>
    Effect.gen(function* () {
      const session = sessions.get(sessionKey(input.threadId, input.terminalId));
      if (!session) return;
      yield* session.lock.withPermits(1)(
        Effect.gen(function* () {
          session.history = "";
          session.sequence += 1;
          session.updatedAt = nowIso();
          yield* Effect.forEach(
            Array.from(session.listeners),
            (listener) =>
              listener({
                type: "cleared",
                threadId: session.threadId,
                terminalId: session.terminalId,
                sequence: session.sequence,
              }),
            { discard: true },
          );
        }),
      );
    });

  const restart: AetherTerminalManager["Service"]["restart"] = (input) =>
    Effect.gen(function* () {
      const key = sessionKey(input.threadId, input.terminalId);
      const session = sessions.get(key);
      if (session) {
        yield* teardownConnection(session);
        session.status = "starting";
        session.history = "";
        session.cols = input.cols;
        session.rows = input.rows;
        yield* establishConnection(session);
        yield* deliver(session, {
          type: "restarted",
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: session.sequence,
          snapshot: snapshotOf(session),
        });
        return snapshotOf(session);
      }
      return yield* open({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
    });

  const handles: AetherTerminalManager["Service"]["handles"] = (threadId) =>
    Effect.gen(function* () {
      const cached = routingCache.get(threadId);
      if (cached !== undefined) return cached;
      const bindingOption = yield* directory.getBinding(ThreadId.make(threadId)).pipe(Effect.orDie);
      const isAether = Option.match(bindingOption, {
        onNone: () => false,
        onSome: (binding) => binding.provider === AETHER_DRIVER_KIND,
      });
      routingCache.set(threadId, isAether);
      return isAether;
    });

  const subscribeMetadata: AetherTerminalManager["Service"]["subscribeMetadata"] = (listener) =>
    Effect.gen(function* () {
      metadataListeners.add(listener);
      const terminals = Array.from(sessions.values()).map(summaryOf);
      yield* listener({ type: "snapshot", terminals });
      return () => {
        metadataListeners.delete(listener);
      };
    }).pipe(
      // If the initial snapshot delivery is interrupted before the unsubscribe
      // is returned, drop the listener so it does not leak.
      Effect.onInterrupt(() => Effect.sync(() => metadataListeners.delete(listener))),
    );

  return {
    handles,
    open,
    attachStream,
    write,
    resize,
    clear,
    restart,
    close,
    subscribeMetadata,
  } satisfies AetherTerminalManager["Service"];
});

export const layer = Layer.effect(AetherTerminalManager, make());
