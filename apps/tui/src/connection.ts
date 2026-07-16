// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics unknownInEffectCatch:off
// @effect-diagnostics globalErrorInEffectFailure:off
import * as NodeFS from "node:fs";

import {
  ApprovalRequestId,
  EnvironmentId,
  type MessageId,
  MessageId as MessageIdSchema,
  type ModelSelection,
  NonNegativeInt,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  OrchestrationProposedPlanId,
  type ProjectId,
  type ProviderApprovalDecision,
  PositiveInt,
  type ProviderInteractionMode,
  type RuntimeMode,
  type GitStackedAction,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalRestartInput,
  type ThreadTurnStartBootstrap,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  TrimmedNonEmptyString,
  type UploadChatImageAttachment,
  type ServerConfig,
  type VcsListRefsResult,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
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
import {
  request,
  rpcSessionFactoryLayer,
  RpcSessionFactory,
  runStream,
  subscribe,
} from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import { mergeVcsStatus } from "./gitActions.logic.ts";

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
import * as DateTime from "effect/DateTime";
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

import { createAttachmentImageCache } from "./attachmentImages.ts";
import type { RgbaImage } from "@t3tools/opentui-image";

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

/** Trim a free-text field, returning a branded value or null when empty. */
const toNullableTrimmed = (value: string | null) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? TrimmedNonEmptyString.make(trimmed) : null;
};

export interface TuiCreateThreadInput {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly firstMessage: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createWorktree: boolean;
  readonly startFromOrigin: boolean;
}

export function buildThreadReplyTurn(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "runtimeMode" | "interactionMode">;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatImageAttachment>;
  readonly modelSelection?: ModelSelection;
}) {
  return {
    threadId: input.thread.id,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.text,
      attachments: [...input.attachments],
    },
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
  };
}

/** Build the web-compatible, server-cleaned-up bootstrap for a thread's first turn. */
export function buildThreadCreationBootstrap(
  input: TuiCreateThreadInput,
  createdAt: string,
  worktreeBranch: string | null,
): ThreadTurnStartBootstrap {
  if (input.createWorktree && (!input.branch?.trim() || !worktreeBranch?.trim())) {
    throw new Error("A base branch is required to create a worktree");
  }
  return {
    createThread: {
      projectId: input.projectId,
      title: TrimmedNonEmptyString.make(input.title),
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: toNullableTrimmed(input.branch),
      worktreePath: toNullableTrimmed(input.worktreePath),
      createdAt,
    },
    ...(input.createWorktree && input.branch && worktreeBranch
      ? {
          prepareWorktree: {
            projectCwd: TrimmedNonEmptyString.make(input.projectCwd),
            baseBranch: TrimmedNonEmptyString.make(input.branch),
            branch: TrimmedNonEmptyString.make(worktreeBranch),
            ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        }
      : {}),
  };
}

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
      return yield* session.closed;
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
          NodeFS.appendFileSync(logPath, `${line}\n`);
        } catch {
          // Logging must never crash the UI.
        }
      }),
    ),
  ]);

export type TuiRuntime = ManagedRuntime.ManagedRuntime<
  | EnvironmentSupervisor
  | Crypto.Crypto
  | EnvironmentCacheStore
  | ThreadSnapshotLoader
  | ShellSnapshotLoader,
  never
>;

/**
 * An in-memory {@link EnvironmentCacheStore}. The web persists the orchestration
 * cache to IndexedDB; the Bun TUI subprocess has no cache dir, so we back it with
 * a `Map`. That still gives within-session persistence — an LRU-evicted thread
 * re-opens instantly from this cache before its live subscription re-establishes.
 */
const inMemoryCacheStoreLayer = Layer.sync(EnvironmentCacheStore, () => {
  // Threads are cached as detail SNAPSHOTS ({ snapshotSequence, thread }) so a
  // cache hit can resume live sync from the right projection sequence.
  const threads = new Map<string, OrchestrationThreadDetailSnapshot>();
  const shells = new Map<string, OrchestrationShellSnapshot>();
  const serverConfigs = new Map<string, ServerConfig>();
  const vcsRefs = new Map<string, VcsListRefsResult>();
  const threadKey = (environmentId: string, threadId: string) =>
    `${environmentId}\u0000${threadId}`;
  return EnvironmentCacheStore.of({
    loadShell: (environmentId) => Effect.succeed(Option.fromUndefinedOr(shells.get(environmentId))),
    saveShell: (environmentId, snapshot) =>
      Effect.sync(() => {
        shells.set(environmentId, snapshot);
      }),
    loadThread: (environmentId, threadId) =>
      Effect.succeed(Option.fromUndefinedOr(threads.get(threadKey(environmentId, threadId)))),
    saveThread: (environmentId, snapshot) =>
      Effect.sync(() => {
        threads.set(threadKey(environmentId, snapshot.thread.id), snapshot);
      }),
    removeThread: (environmentId, threadId) =>
      Effect.sync(() => {
        threads.delete(threadKey(environmentId, threadId));
      }),
    loadServerConfig: (environmentId) =>
      Effect.succeed(Option.fromUndefinedOr(serverConfigs.get(environmentId))),
    saveServerConfig: (environmentId, config) =>
      Effect.sync(() => {
        serverConfigs.set(environmentId, config);
      }),
    loadVcsRefs: (environmentId, cwd) =>
      Effect.succeed(Option.fromUndefinedOr(vcsRefs.get(`${environmentId}\u0000${cwd}`))),
    saveVcsRefs: (environmentId, cwd, refs) =>
      Effect.sync(() => {
        vcsRefs.set(`${environmentId}\u0000${cwd}`, refs);
      }),
    clear: (environmentId) =>
      Effect.sync(() => {
        shells.delete(environmentId);
        serverConfigs.delete(environmentId);
        for (const key of vcsRefs.keys()) {
          if (key.startsWith(`${environmentId}\u0000`)) vcsRefs.delete(key);
        }
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

  // HTTP snapshot preloading (web's fast-path before live sync) is an
  // optimization the TUI doesn't need: Option.none() makes the state machines
  // fall back to the socket-embedded snapshots, the TUI's existing sole path.
  const noopSnapshotLoaders = Layer.mergeAll(
    Layer.succeed(
      ThreadSnapshotLoader,
      ThreadSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
    ),
    Layer.succeed(
      ShellSnapshotLoader,
      ShellSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
    ),
  );

  const runtimeLayer = Layer.mergeAll(
    supervisorLayer,
    inMemoryCacheStoreLayer,
    noopSnapshotLoaders,
  );

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
    attachments?: ReadonlyArray<UploadChatImageAttachment>,
    modelSelection?: ModelSelection,
  ) => Promise<void>;
  readonly createThread: (input: TuiCreateThreadInput) => Promise<ThreadId>;
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
  /** Live git status for a worktree (folded from the snapshot/local/remote stream). */
  readonly subscribeVcsStatus: (
    cwd: string,
    onStatus: (status: VcsStatusResult) => void,
  ) => () => void;
  /** Run a stacked git action (commit/push/create_pr/…); resolves when it finishes. */
  readonly runGitStackedAction: (input: {
    readonly cwd: string;
    readonly action: GitStackedAction;
    readonly commitMessage?: string;
    readonly featureBranch?: boolean;
  }) => Promise<void>;
  /** Pull the worktree's branch from its upstream. */
  readonly runGitPull: (cwd: string) => Promise<void>;
  /** Fetch the unified diff for the turn that produced the given checkpoint. */
  readonly getTurnDiff: (threadId: ThreadId, toTurnCount: number) => Promise<string>;
  /** Fetch the cumulative diff of all changes in the thread up to `toTurnCount`. */
  readonly getFullThreadDiff: (threadId: ThreadId, toTurnCount: number) => Promise<string>;
  /** The selectable models reported by the server's configured providers. */
  readonly listModels: () => Promise<ModelOption[]>;
  /** Current server settings, including new-thread workspace defaults. */
  readonly getServerConfig: () => Promise<ServerConfig>;
  /** Git refs available as base branches for a project's new worktree. */
  readonly listRefs: (cwd: string) => Promise<VcsListRefsResult>;
  readonly terminalWrite: (threadId: ThreadId, terminalId: string, data: string) => Promise<void>;
  readonly terminalResize: (
    threadId: ThreadId,
    terminalId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  /** Clear one terminal's persisted history and visible buffer. */
  readonly terminalClear: (threadId: ThreadId, terminalId: string) => Promise<void>;
  /** Restart one terminal session in-place, preserving its tab identity. */
  readonly terminalRestart: (input: TerminalRestartInput) => Promise<void>;
  /** Close one terminal session (and its history) for a thread. */
  readonly terminalClose: (threadId: ThreadId, terminalId: string) => Promise<void>;
  /**
   * Subscribe to the environment's terminal-metadata stream so the UI can
   * discover sessions it didn't open itself (agent-spawned, web-created, or
   * from a prior run). Emits a snapshot, then upsert/remove deltas.
   */
  readonly subscribeTerminalMetadata: (
    onEvent: (event: TerminalMetadataStreamEvent) => void,
  ) => () => void;
  /** Resolve a message image attachment to an absolute URL, or null on failure. */
  readonly getAttachmentUrl: (attachmentId: string) => Promise<string | null>;
  /** Download and decode a bounded RGBA preview for a resolved attachment URL. */
  readonly getAttachmentImage: (
    attachmentId: string,
    resolvedUrl: string,
  ) => Promise<RgbaImage | null>;
  /** List the workspace's files + directories (bounded index) for the file browser. */
  readonly listEntries: (
    cwd: string,
  ) => Promise<ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>>;
  /** Read a workspace file's contents, or null on failure. */
  readonly readFile: (cwd: string, relativePath: string) => Promise<string | null>;
  /** Read a bounded workspace file as base64 for attachment preparation. */
  readonly readFileBase64: (
    cwd: string,
    relativePath: string,
  ) => Promise<{
    readonly contents: string;
    readonly byteLength: number;
    readonly truncated: boolean;
  } | null>;
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

export function makeTuiClient(runtime: TuiRuntime, origin = ""): TuiClient {
  const attachmentImages = createAttachmentImageCache();
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
      | EnvironmentSupervisor
      | EnvironmentCacheStore
      | ThreadSnapshotLoader
      | ShellSnapshotLoader
      | Scope.Scope
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
          return yield* Effect.never;
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
  // Monotonic id correlating a stacked-git-action's progress stream on the server.
  let gitActionSeq = 0;

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
    let resolveRef: (
      ref: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>,
    ) => void = () => {};
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

    sendReply: (thread, text, attachments = [], modelSelection) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const messageId = MessageIdSchema.make(yield* newId);
          if (modelSelection) {
            // Keep thread metadata and the active provider session in sync. The
            // turn-level selection is what makes an existing session actually
            // switch models; metadata alone only updates the persisted label.
            yield* updateThreadMetadata({ threadId: thread.id, modelSelection });
          }
          yield* startThreadTurn(
            buildThreadReplyTurn({
              thread,
              messageId,
              text,
              attachments,
              ...(modelSelection ? { modelSelection } : {}),
            }),
          );
        }),
      ),

    createThread: (input) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const threadId = ThreadIdSchema.make(yield* newId);
          const messageId = MessageIdSchema.make(yield* newId);
          const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const worktreeToken = input.createWorktree ? yield* newId : null;
          const worktreeBranch = worktreeToken
            ? buildTemporaryWorktreeBranchName((byteLength) =>
                worktreeToken.replaceAll("-", "").slice(0, byteLength * 2),
              )
            : null;
          yield* startThreadTurn({
            threadId,
            message: { messageId, role: "user", text: input.firstMessage, attachments: [] },
            modelSelection: input.modelSelection,
            titleSeed: TrimmedNonEmptyString.make(input.title),
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            bootstrap: buildThreadCreationBootstrap(input, createdAt, worktreeBranch),
            createdAt,
          });
          return threadId;
        }),
      ),

    implementPlan: (thread, planId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          // Implementing means leaving plan mode so the agent executes the plan.
          // Persist the thread's interaction mode first (mirrors the web's
          // persistThreadSettingsForNextTurn → setThreadInteractionMode) so the
          // composer reflects build mode and later replies don't revert to plan.
          yield* setThreadInteractionMode({ threadId: thread.id, interactionMode: "default" });
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
            interactionMode: "default",
            sourceProposedPlan: {
              threadId: thread.id,
              planId: OrchestrationProposedPlanId.make(planId),
            },
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

    subscribeTerminalMetadata: (onEvent) => {
      const stream = subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.tap((event) => Effect.sync(() => onEvent(event))),
      );
      return forkUnsub(stream);
    },

    subscribeVcsStatus: (cwd, onStatus) => {
      // The stream delivers split local/remote results; fold them into the
      // combined VcsStatusResult the UI + gitActions logic expect. Remote may
      // be null (no upstream resolved yet) — fall back to "no remote" defaults.
      let local: VcsStatusLocalResult | null = null;
      let remote: VcsStatusRemoteResult | null = null;
      const emit = () => {
        const merged = mergeVcsStatus(local, remote);
        if (merged) onStatus(merged);
      };
      const stream = subscribe(WS_METHODS.subscribeVcsStatus, { cwd }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event._tag === "snapshot") {
              local = event.local;
              remote = event.remote;
            } else if (event._tag === "localUpdated") {
              local = event.local;
            } else {
              remote = event.remote;
            }
            emit();
          }),
        ),
      );
      return forkUnsub(stream);
    },

    runGitStackedAction: (input) =>
      runtime.runPromise(
        runStream(WS_METHODS.gitRunStackedAction, {
          actionId: `tui-action-${++gitActionSeq}`,
          cwd: input.cwd,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch !== undefined ? { featureBranch: input.featureBranch } : {}),
        }).pipe(
          // The stream ends when the action completes; an action_failed event (or a
          // failed stream) surfaces as a rejected promise.
          Stream.runForEach((event) =>
            event.kind === "action_failed" ? Effect.fail(new Error(event.message)) : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),

    runGitPull: (cwd) =>
      runtime.runPromise(request(WS_METHODS.vcsPull, { cwd }).pipe(Effect.asVoid)),

    getTurnDiff: (threadId, toTurnCount) =>
      runtime.runPromise(
        request(ORCHESTRATION_WS_METHODS.getTurnDiff, {
          threadId,
          fromTurnCount: NonNegativeInt.make(Math.max(0, toTurnCount - 1)),
          toTurnCount: NonNegativeInt.make(toTurnCount),
        }).pipe(Effect.map((result) => result.diff)),
      ),

  getFullThreadDiff: (threadId, toTurnCount) =>
    runtime.runPromise(
      request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
          threadId,
          toTurnCount: NonNegativeInt.make(toTurnCount),
        }).pipe(Effect.map((result) => result.diff)),
      ),

    listModels: () =>
      runtime.runPromise(
        request(WS_METHODS.serverGetConfig, {}).pipe(
          Effect.map((config) => flattenModelOptions(config.providers)),
        ),
      ),

    getServerConfig: () => runtime.runPromise(request(WS_METHODS.serverGetConfig, {})),

    listRefs: (cwd) =>
      runtime.runPromise(
        request(WS_METHODS.vcsListRefs, {
          cwd,
          limit: PositiveInt.make(100),
        }),
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

    terminalClear: (threadId, terminalId) =>
      runtime.runPromise(
        request(WS_METHODS.terminalClear, { threadId, terminalId }).pipe(Effect.asVoid),
      ),

    terminalRestart: (input) =>
      runtime.runPromise(request(WS_METHODS.terminalRestart, input).pipe(Effect.asVoid)),

    terminalClose: (threadId, terminalId) =>
      runtime.runPromise(
        request(WS_METHODS.terminalClose, { threadId, terminalId, deleteHistory: true }).pipe(
          Effect.asVoid,
        ),
      ),

    listEntries: (cwd) =>
      runtime
        .runPromise(
          request(WS_METHODS.projectsListEntries, { cwd }).pipe(Effect.map((r) => r.entries)),
        )
        .catch(() => []),

    readFile: (cwd, relativePath) =>
      runtime
        .runPromise(
          request(WS_METHODS.projectsReadFile, { cwd, relativePath }).pipe(
            Effect.map((r) => r.contents),
          ),
        )
        .catch(() => null),

    readFileBase64: (cwd, relativePath) =>
      runtime
        .runPromise(
          request(WS_METHODS.projectsReadFile, { cwd, relativePath, encoding: "base64" }).pipe(
            Effect.map(({ contents, byteLength, truncated }) => ({
              contents,
              byteLength,
              truncated,
            })),
          ),
        )
        .catch(() => null),

    getAttachmentUrl: (attachmentId) =>
      runtime
        .runPromise(
          request(WS_METHODS.assetsCreateUrl, {
            resource: { _tag: "attachment", attachmentId },
          }).pipe(
            Effect.map((result) => {
              try {
                return new URL(result.relativeUrl, origin || undefined).toString();
              } catch {
                return result.relativeUrl;
              }
            }),
          ),
        )
        .catch(() => null),

    getAttachmentImage: (attachmentId, resolvedUrl) =>
      attachmentImages.load(attachmentId, resolvedUrl),

    dispose: () => {
      disposeWarm();
      attachmentImages.clear();
      return runtime.dispose();
    },
  };
}

export type { OrchestrationShellSnapshot, OrchestrationThread };
