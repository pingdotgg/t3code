import { appendFileSync } from "node:fs";

import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId as MessageIdSchema,
  type ModelSelection,
  NonNegativeInt,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  OrchestrationProposedPlanId,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type TerminalAttachStreamEvent,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  archiveThread as archiveThreadOp,
  createThread as createThreadOp,
  deleteThread as deleteThreadOp,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  startThreadTurn,
  revertThreadCheckpoint,
  stopThreadSession,
  unarchiveThread as unarchiveThreadOp,
  updateThreadMetadata,
} from "@t3tools/client-runtime/operations";
import { request, rpcSessionFactoryLayer, RpcSessionFactory, subscribe } from "@t3tools/client-runtime/rpc";
import type { RpcSession } from "@t3tools/client-runtime/rpc";

import { flattenModelOptions, type ModelOption } from "./models.ts";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import {
  type EnvironmentShellState,
  makeEnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentThreadState,
  makeEnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Connection inputs the host (the server CLI) provides. The TUI never talks to
 * the server's auth internals directly — the host issues a long-lived bearer
 * session and hands us a `mintSocketUrl` that returns a freshly-ticketed
 * `ws(s)://…/ws?wsTicket=…` URL on every (re)connect.
 */
export interface TuiOptions {
  /** Origin of the already-running local server, e.g. `http://127.0.0.1:5733`. */
  readonly origin: string;
  /** Long-lived bearer token used for HTTP authorization on the connection. */
  readonly bearerToken: string;
  /** Mint a fresh, fully-formed websocket URL (with a short-lived ticket). */
  readonly mintSocketUrl: () => Promise<string>;
  /** File the Effect runtime logs to (Ink owns stdout, so never log there). */
  readonly logPath: string;
}

/** Stable id used to label this client's connection in traces/logs. */
const TUI_ENVIRONMENT_ID = EnvironmentId.make("local-tui");
const TUI_LABEL = "T3 Code";
const RECONNECT_DELAY = Duration.seconds(2);

const CONNECTING_STATE: SupervisorConnectionState = {
  desired: true,
  network: "online",
  phase: "connecting",
  stage: "opening",
  attempt: 1,
  generation: 0,
  lastFailure: null,
  retryAt: null,
};

const CONNECTED_STATE: SupervisorConnectionState = {
  ...CONNECTING_STATE,
  phase: "connected",
  stage: null,
};

/**
 * A minimal {@link EnvironmentSupervisor} for the TUI. It maintains a single
 * loopback connection to the already-running local server, re-minting a fresh
 * websocket URL on every (re)connect attempt via the host-provided
 * `mintSocketUrl`. We reuse the heavy `client-runtime` RPC client + reducers but
 * skip its multi-environment relay machinery, which the TUI does not need.
 */
const makeTuiSupervisor = (options: TuiOptions) =>
  Effect.gen(function* () {
    const factory = yield* RpcSessionFactory;
    const { origin } = options;

    const target = new PrimaryConnectionTarget({
      environmentId: TUI_ENVIRONMENT_ID,
      label: TUI_LABEL,
      httpBaseUrl: origin,
      wsBaseUrl: origin,
    });

    const sessionRef = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
    const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>(CONNECTING_STATE);
    const preparedRef = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.none(),
    );

    const runConnection = Effect.gen(function* () {
      const socketUrl = yield* Effect.tryPromise({
        try: () => options.mintSocketUrl(),
        catch: (cause) => cause,
      });
      const prepared: PreparedConnection = {
        environmentId: TUI_ENVIRONMENT_ID,
        label: TUI_LABEL,
        httpBaseUrl: origin,
        socketUrl,
        httpAuthorization: { _tag: "Bearer", token: options.bearerToken },
        target,
      };
      yield* SubscriptionRef.set(preparedRef, Option.some(prepared));
      const session = yield* factory.connect(prepared);
      yield* session.ready;
      yield* SubscriptionRef.set(sessionRef, Option.some(session));
      yield* SubscriptionRef.set(stateRef, CONNECTED_STATE);
      // `closed` fails when the socket drops; that unwinds the scope below.
      yield* session.closed;
    });

    const loop = Effect.gen(function* () {
      for (;;) {
        yield* Effect.scoped(runConnection).pipe(Effect.ignore);
        yield* SubscriptionRef.set(sessionRef, Option.none());
        yield* SubscriptionRef.set(stateRef, CONNECTING_STATE);
        yield* Effect.sleep(RECONNECT_DELAY);
      }
    });

    yield* Effect.forkScoped(loop);

    return EnvironmentSupervisor.of({
      target,
      state: stateRef,
      session: sessionRef,
      prepared: preparedRef,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });

/** Effect-side logger that never touches stdout (Ink owns the screen). */
const fileLoggerLayer = (logPath: string) =>
  Logger.layer([
    Logger.formatJson.pipe(
      Logger.map((line: string) => {
        try {
          appendFileSync(logPath, `${line}\n`);
        } catch {
          // Logging must never crash the UI.
        }
      }),
    ),
  ]);

export type TuiRuntime = ManagedRuntime.ManagedRuntime<
  EnvironmentSupervisor | Crypto.Crypto | EnvironmentCacheStore,
  never
>;

/**
 * An in-memory {@link EnvironmentCacheStore}. The web persists the orchestration
 * cache to IndexedDB; the Bun TUI subprocess has no cache dir, so we back it with
 * a `Map`. That still gives within-session persistence — an LRU-evicted thread
 * re-opens instantly from this cache before its live subscription re-establishes.
 */
const inMemoryCacheStoreLayer = Layer.sync(EnvironmentCacheStore, () => {
  const threads = new Map<string, OrchestrationThread>();
  const shells = new Map<string, OrchestrationShellSnapshot>();
  const threadKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;
  return EnvironmentCacheStore.of({
    loadShell: (environmentId) => Effect.succeed(Option.fromUndefinedOr(shells.get(environmentId))),
    saveShell: (environmentId, snapshot) =>
      Effect.sync(() => {
        shells.set(environmentId, snapshot);
      }),
    loadThread: (environmentId, threadId) =>
      Effect.succeed(Option.fromUndefinedOr(threads.get(threadKey(environmentId, threadId)))),
    saveThread: (environmentId, thread) =>
      Effect.sync(() => {
        threads.set(threadKey(environmentId, thread.id), thread);
      }),
    removeThread: (environmentId, threadId) =>
      Effect.sync(() => {
        threads.delete(threadKey(environmentId, threadId));
      }),
    clear: (environmentId) =>
      Effect.sync(() => {
        shells.delete(environmentId);
        for (const key of threads.keys()) {
          if (key.startsWith(`${environmentId}\u0000`)) threads.delete(key);
        }
      }),
  });
});

/**
 * Assemble a self-contained runtime that provides {@link EnvironmentSupervisor}
 * and {@link Crypto.Crypto} so the UI can issue RPC requests and subscriptions
 * without knowing anything about Effect layers.
 */
export function buildTuiRuntime(options: TuiOptions): TuiRuntime {
  const services = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(References.MinimumLogLevel, "Error"),
    fileLoggerLayer(options.logPath),
  );

  const rpcLayer = rpcSessionFactoryLayer.pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

  const supervisorLayer = Layer.effect(EnvironmentSupervisor, makeTuiSupervisor(options)).pipe(
    Layer.provideMerge(rpcLayer),
    Layer.provideMerge(services),
  );

  const runtimeLayer = Layer.mergeAll(supervisorLayer, inMemoryCacheStoreLayer);

  return ManagedRuntime.make(runtimeLayer) as unknown as TuiRuntime;
}

// ── Imperative client surface consumed by the UI components ────────────────

export interface TuiClient {
  /** Live list of every project + thread. Returns an unsubscribe fn. */
  readonly subscribeShell: (
    onSnapshot: (snapshot: OrchestrationShellSnapshot) => void,
  ) => () => void;
  /** Live detail (messages, session, activities) for one thread. */
  readonly subscribeThread: (
    threadId: ThreadId,
    onThread: (thread: OrchestrationThread) => void,
  ) => () => void;
  /** Last-seen detail for a thread (from the warm cache), or null. Synchronous. */
  readonly peekThread: (threadId: ThreadId) => OrchestrationThread | null;
  /** Attach to a thread terminal; raw PTY bytes are delivered via onEvent. */
  readonly subscribeTerminal: (
    input: {
      readonly threadId: ThreadId;
      readonly terminalId: string;
      readonly cwd: string;
      readonly worktreePath: string | null;
      readonly cols: number;
      readonly rows: number;
    },
    onEvent: (event: TerminalAttachStreamEvent) => void,
  ) => () => void;
  readonly sendReply: (
    thread: Pick<OrchestrationThread, "id" | "runtimeMode" | "interactionMode">,
    text: string,
  ) => Promise<void>;
  readonly createThread: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly firstMessage: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  readonly implementPlan: (
    thread: Pick<OrchestrationThread, "id" | "runtimeMode">,
    planId: string,
  ) => Promise<void>;
  readonly interrupt: (threadId: ThreadId) => Promise<void>;
  readonly approve: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly respondUserInput: (
    threadId: ThreadId,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>;
  readonly setRuntimeMode: (threadId: ThreadId, mode: RuntimeMode) => Promise<void>;
  readonly setInteractionMode: (threadId: ThreadId, mode: ProviderInteractionMode) => Promise<void>;
  readonly renameThread: (threadId: ThreadId, title: string) => Promise<void>;
  readonly archiveThread: (threadId: ThreadId) => Promise<void>;
  readonly unarchiveThread: (threadId: ThreadId) => Promise<void>;
  readonly deleteThread: (threadId: ThreadId) => Promise<void>;
  readonly stopSession: (threadId: ThreadId) => Promise<void>;
  readonly revertCheckpoint: (threadId: ThreadId, turnCount: number) => Promise<void>;
  /** Fetch the unified diff for the turn that produced the given checkpoint. */
  readonly getTurnDiff: (threadId: ThreadId, toTurnCount: number) => Promise<string>;
  /** The selectable models reported by the server's configured providers. */
  readonly listModels: () => Promise<ModelOption[]>;
  readonly setModel: (threadId: ThreadId, instanceId: string, model: string) => Promise<void>;
  readonly terminalWrite: (
    threadId: ThreadId,
    terminalId: string,
    data: string,
  ) => Promise<void>;
  readonly terminalResize: (
    threadId: ThreadId,
    terminalId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const newId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
});

/** A long-lived SubscriptionRef kept warm in its own scope until `close()`. */
interface WarmRef<S> {
  readonly ref: Promise<SubscriptionRef.SubscriptionRef<S>>;
  readonly close: () => void;
  order: number;
}

/** Number of recently-viewed threads whose live state we keep warm (LRU). */
const THREAD_WARM_LIMIT = 8;

export function makeTuiClient(runtime: TuiRuntime): TuiClient {
  const forkUnsub = <A>(stream: Stream.Stream<A, unknown, EnvironmentSupervisor>): (() => void) => {
    const fiber = runtime.runFork(Stream.runDrain(stream));
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  };

  // ── Warm state registry (the web's caching engine) ──────────────────────────
  //
  // `makeEnvironmentThreadState`/`makeEnvironmentShellState` build a SubscriptionRef
  // that loads the cache, subscribes to the socket, applies referentially-stable
  // deltas, persists on close, and re-syncs on reconnect. We run each in a scope we
  // keep open (Effect.never) so it stays warm; closing the scope interrupts it and
  // flushes the last value to the in-memory cache.

  const startWarm = <S>(
    build: Effect.Effect<
      SubscriptionRef.SubscriptionRef<S>,
      never,
      EnvironmentSupervisor | EnvironmentCacheStore | Scope.Scope
    >,
  ): WarmRef<S> => {
    let resolveRef: (ref: SubscriptionRef.SubscriptionRef<S>) => void = () => {};
    const ref = new Promise<SubscriptionRef.SubscriptionRef<S>>((resolve) => {
      resolveRef = resolve;
    });
    const fiber = runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriptionRef = yield* build;
          resolveRef(subscriptionRef);
          yield* Effect.never;
        }),
      ),
    );
    return {
      ref,
      close: () => {
        runtime.runFork(Fiber.interrupt(fiber));
      },
      order: 0,
    };
  };

  /** Stream a warm ref's changes into a callback; returns an unsubscribe. */
  const followWarm = <S>(entry: WarmRef<S>, onValue: (value: S) => void): (() => void) => {
    let cancelled = false;
    let fiber: Fiber.Fiber<void, unknown> | null = null;
    void entry.ref.then((subscriptionRef) => {
      if (cancelled) return;
      fiber = runtime.runFork(
        SubscriptionRef.changes(subscriptionRef).pipe(
          Stream.runForEach((value) => Effect.sync(() => onValue(value))),
        ),
      );
    });
    return () => {
      cancelled = true;
      if (fiber) runtime.runFork(Fiber.interrupt(fiber));
    };
  };

  const warmThreads = new Map<string, WarmRef<EnvironmentThreadState>>();
  // Last-seen detail per thread, kept in sync by the UI subscription, so a
  // re-select can paint instantly (no blank) before the fresh value streams in.
  const latestThreads = new Map<string, OrchestrationThread>();
  let warmOrder = 0;
  let shellWarm: WarmRef<EnvironmentShellState> | null = null;

  /** Close a warm thread's scope and drop its cached snapshot. */
  const evictThread = (key: string) => {
    warmThreads.get(key)?.close();
    warmThreads.delete(key);
    latestThreads.delete(key);
  };

  const acquireThread = (threadId: ThreadId): WarmRef<EnvironmentThreadState> => {
    const key = threadId as string;
    const existing = warmThreads.get(key);
    if (existing) {
      existing.order = ++warmOrder;
      return existing;
    }
    // Build the warm thread state and keep it live in its own scope. An internal
    // watcher keeps `latestThreads` fresh (so peekThread is instant) and evicts the
    // entry if the thread is deleted — otherwise makeEnvironmentThreadState retries
    // its now-failing subscription every 250ms forever and hammers the server.
    let resolveRef: (ref: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>) => void =
      () => {};
    const ref = new Promise<SubscriptionRef.SubscriptionRef<EnvironmentThreadState>>((resolve) => {
      resolveRef = resolve;
    });
    const fiber = runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriptionRef = yield* makeEnvironmentThreadState(threadId);
          resolveRef(subscriptionRef);
          yield* SubscriptionRef.changes(subscriptionRef).pipe(
            Stream.runForEach((state) =>
              Effect.sync(() => {
                if (Option.isSome(state.data)) latestThreads.set(key, state.data.value);
                if (state.status === "deleted") evictThread(key);
              }),
            ),
          );
        }),
      ),
    );
    const entry: WarmRef<EnvironmentThreadState> = {
      ref,
      close: () => {
        runtime.runFork(Fiber.interrupt(fiber));
      },
      order: ++warmOrder,
    };
    warmThreads.set(key, entry);
    // Evict the least-recently-used warm thread beyond the cap (never the new one).
    if (warmThreads.size > THREAD_WARM_LIMIT) {
      let oldestKey: string | null = null;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of warmThreads) {
        if (candidate.order < oldestOrder) {
          oldestOrder = candidate.order;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey !== null && oldestKey !== key) evictThread(oldestKey);
    }
    return entry;
  };

  const disposeWarm = () => {
    for (const entry of warmThreads.values()) entry.close();
    warmThreads.clear();
    latestThreads.clear();
    shellWarm?.close();
    shellWarm = null;
  };

  return {
    subscribeShell: (onSnapshot) => {
      shellWarm ??= startWarm(makeEnvironmentShellState());
      return followWarm(shellWarm, (state) => {
        if (Option.isSome(state.snapshot)) onSnapshot(state.snapshot.value);
      });
    },

    subscribeThread: (threadId, onThread) => {
      const entry = acquireThread(threadId);
      return followWarm(entry, (state) => {
        if (Option.isSome(state.data)) onThread(state.data.value);
      });
    },

    peekThread: (threadId) => latestThreads.get(threadId as string) ?? null,

    subscribeTerminal: (input, onEvent) => {
      const stream = subscribe(WS_METHODS.terminalAttach, {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath,
        cols: input.cols,
        rows: input.rows,
        restartIfNotRunning: true,
      }).pipe(Stream.tap((event) => Effect.sync(() => onEvent(event))));
      return forkUnsub(stream);
    },

    sendReply: (thread, text) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const messageId = MessageIdSchema.make(yield* newId);
          yield* startThreadTurn({
            threadId: thread.id,
            message: { messageId, role: "user", text, attachments: [] },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          });
        }),
      ),

    createThread: (input) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const threadId = ThreadIdSchema.make(yield* newId);
          yield* createThreadOp({
            threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
          });
          const messageId = MessageIdSchema.make(yield* newId);
          yield* startThreadTurn({
            threadId,
            message: { messageId, role: "user", text: input.firstMessage, attachments: [] },
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
          });
        }),
      ),

    implementPlan: (thread, planId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const messageId = MessageIdSchema.make(yield* newId);
          yield* startThreadTurn({
            threadId: thread.id,
            message: {
              messageId,
              role: "user",
              text: "Implement the plan.",
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            // Implementing means leaving plan mode so the agent executes the plan.
            interactionMode: "default",
            sourceProposedPlan: { threadId: thread.id, planId: OrchestrationProposedPlanId.make(planId) },
          });
        }),
      ),

    interrupt: (threadId) =>
      runtime.runPromise(interruptThreadTurn({ threadId }).pipe(Effect.asVoid)),

    approve: (threadId, requestId, decision) =>
      runtime.runPromise(
        respondToThreadApproval({
          threadId,
          requestId: ApprovalRequestId.make(requestId),
          decision,
        }).pipe(Effect.asVoid),
      ),

    respondUserInput: (threadId, requestId, answers) =>
      runtime.runPromise(
        respondToThreadUserInput({
          threadId,
          requestId: ApprovalRequestId.make(requestId),
          answers,
        }).pipe(Effect.asVoid),
      ),

    setRuntimeMode: (threadId, mode) =>
      runtime.runPromise(setThreadRuntimeMode({ threadId, runtimeMode: mode }).pipe(Effect.asVoid)),

    setInteractionMode: (threadId, mode) =>
      runtime.runPromise(
        setThreadInteractionMode({ threadId, interactionMode: mode }).pipe(Effect.asVoid),
      ),

    renameThread: (threadId, title) =>
      runtime.runPromise(
        updateThreadMetadata({ threadId, title: TrimmedNonEmptyString.make(title) }).pipe(
          Effect.asVoid,
        ),
      ),

    archiveThread: (threadId) =>
      runtime.runPromise(archiveThreadOp({ threadId }).pipe(Effect.asVoid)),

    unarchiveThread: (threadId) =>
      runtime.runPromise(unarchiveThreadOp({ threadId }).pipe(Effect.asVoid)),

    deleteThread: (threadId) =>
      runtime.runPromise(deleteThreadOp({ threadId }).pipe(Effect.asVoid)),

    stopSession: (threadId) =>
      runtime.runPromise(stopThreadSession({ threadId }).pipe(Effect.asVoid)),

    revertCheckpoint: (threadId, turnCount) =>
      runtime.runPromise(
        revertThreadCheckpoint({ threadId, turnCount: NonNegativeInt.make(turnCount) }).pipe(
          Effect.asVoid,
        ),
      ),

    getTurnDiff: (threadId, toTurnCount) =>
      runtime.runPromise(
        request(ORCHESTRATION_WS_METHODS.getTurnDiff, {
          threadId,
          fromTurnCount: NonNegativeInt.make(Math.max(0, toTurnCount - 1)),
          toTurnCount: NonNegativeInt.make(toTurnCount),
        }).pipe(Effect.map((result) => result.diff)),
      ),

    listModels: () =>
      runtime.runPromise(
        request(WS_METHODS.serverGetConfig, {}).pipe(
          Effect.map((config) => flattenModelOptions(config.providers)),
        ),
      ),

    setModel: (threadId, instanceId, model) =>
      runtime.runPromise(
        updateThreadMetadata({
          threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model: TrimmedNonEmptyString.make(model),
          },
        }).pipe(Effect.asVoid),
      ),

    terminalWrite: (threadId, terminalId, data) =>
      runtime.runPromise(
        request(WS_METHODS.terminalWrite, { threadId, terminalId, data }).pipe(Effect.asVoid),
      ),

    terminalResize: (threadId, terminalId, cols, rows) =>
      runtime.runPromise(
        request(WS_METHODS.terminalResize, { threadId, terminalId, cols, rows }).pipe(
          Effect.asVoid,
        ),
      ),

    dispose: () => {
      disposeWarm();
      return runtime.dispose();
    },
  };
}

export type { OrchestrationShellSnapshot, OrchestrationThread };
