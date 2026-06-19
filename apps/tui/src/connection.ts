import { appendFileSync } from "node:fs";

import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId as MessageIdSchema,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type ProjectId,
  type ProviderApprovalDecision,
  type RuntimeMode,
  type TerminalAttachStreamEvent,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  createThread as createThreadOp,
  interruptThreadTurn,
  respondToThreadApproval,
  setThreadRuntimeMode,
  startThreadTurn,
} from "@t3tools/client-runtime/operations";
import { request, rpcSessionFactoryLayer, RpcSessionFactory, subscribe } from "@t3tools/client-runtime/rpc";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell-reducer";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/thread-reducer";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as References from "effect/References";
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
  EnvironmentSupervisor | Crypto.Crypto,
  never
>;

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

  return ManagedRuntime.make(supervisorLayer) as unknown as TuiRuntime;
}

// ── Imperative client surface consumed by the Ink components ───────────────

export interface ThreadListEntry {
  readonly snapshot: OrchestrationShellSnapshot;
}

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
  }) => Promise<void>;
  readonly interrupt: (threadId: ThreadId) => Promise<void>;
  readonly approve: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly setRuntimeMode: (threadId: ThreadId, mode: RuntimeMode) => Promise<void>;
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

export function makeTuiClient(runtime: TuiRuntime): TuiClient {
  const forkUnsub = <A>(stream: Stream.Stream<A, unknown, EnvironmentSupervisor>): (() => void) => {
    const fiber = runtime.runFork(Stream.runDrain(stream));
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  };

  return {
    subscribeShell: (onSnapshot) => {
      let current: OrchestrationShellSnapshot | null = null;
      const stream = subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            if (item.kind === "snapshot") {
              current = item.snapshot;
            } else if (current && item.sequence > current.snapshotSequence) {
              current = applyShellStreamEvent(current, item);
            }
            if (current) {
              onSnapshot(current);
            }
          }),
        ),
      );
      return forkUnsub(stream);
    },

    subscribeThread: (threadId, onThread) => {
      let current: OrchestrationThread | null = null;
      const stream = subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId }).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            if (item.kind === "snapshot") {
              current = item.snapshot.thread;
            } else if (current) {
              const result = applyThreadDetailEvent(current, item.event);
              if (result.kind === "updated") {
                current = result.thread;
              } else if (result.kind === "deleted") {
                current = null;
              }
            }
            if (current) {
              onThread(current);
            }
          }),
        ),
      );
      return forkUnsub(stream);
    },

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
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const messageId = MessageIdSchema.make(yield* newId);
          yield* startThreadTurn({
            threadId,
            message: { messageId, role: "user", text: input.firstMessage, attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
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

    setRuntimeMode: (threadId, mode) =>
      runtime.runPromise(setThreadRuntimeMode({ threadId, runtimeMode: mode }).pipe(Effect.asVoid)),

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

    dispose: () => runtime.dispose(),
  };
}

export type { OrchestrationShellSnapshot, OrchestrationThread };
