/**
 * OpenCode2Adapter — thin facade wiring the `opencode2` provider split into
 * a full `ProviderAdapterShape`.
 *
 * Owns the event queue + session store and delegates: lifecycle and reads
 * to `OpenCode2SessionStore`, turns to `OpenCode2TurnRuntime`, approvals to
 * `OpenCode2Approvals`. The v2 client binding arrives via
 * `OpenCode2AdapterDeps.createClient` (the driver adapts the Effect-based
 * `@opencode/client/effect` SDK client to the structural Promise-based
 * `OpenCode2SessionClient` inside `server.withConnection`; the default
 * fails typed until a real binding exists).
 *
 * Implemented: startSession, sendTurn, interruptTurn, respondToRequest,
 * respondToUserInput, stopSession, stopAll, listSessions, hasSession,
 * readThread, rollbackThread (fork-before-msg rewind; native session.revert
 * only rewrites workspace files), compaction (native session.compact + wait).
 *
 * @module provider/Layers/OpenCode2Adapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { OPENCODE2_DRIVER_KIND, type OpenCode2Settings } from "../OpenCode2Settings.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  respondToOpenCode2Request,
  respondToOpenCode2UserInput,
} from "../opencode2/OpenCode2Approvals.ts";
import {
  buildOpenCode2PermissionRules,
  isSameOpenCode2Directory,
  openCode2RequestError,
  openCode2SessionClosedError,
  openCode2SessionNotFoundError,
  type OpenCode2AdapterError,
} from "../opencode2/OpenCode2Protocol.ts";
import {
  hasOpenCode2Session,
  listOpenCode2Sessions,
  makeOpenCode2SessionStore,
  OPENCODE2_CONNECTION_TIMEOUT_MS,
  readOpenCode2Thread,
  rollbackOpenCode2Thread,
  startOpenCode2Session,
  stopAllOpenCode2Contexts,
  stopOpenCode2Context,
  type OpenCode2RawEvent,
  type OpenCode2SessionClient,
  type OpenCode2SessionContext,
  type OpenCode2SessionStore,
} from "../opencode2/OpenCode2SessionStore.ts";
import {
  compactOpenCode2Thread,
  interruptOpenCode2Turn,
  nowIsoDefault,
  sendOpenCode2Turn,
} from "../opencode2/OpenCode2TurnRuntime.ts";
import { startOpenCode2EventPump } from "../opencode2/OpenCode2SessionStore.ts";

/** Best-effort read of a string model-selection option (mirrors @t3tools/shared behavior). */
const getModelSelectionAgent = (
  modelSelection: NonNullable<ProviderSendTurnInput["modelSelection"]>,
): string | undefined => {
  const options = (modelSelection as { readonly options?: unknown }).options;
  if (!Array.isArray(options)) {
    return undefined;
  }
  for (const option of options) {
    if (
      typeof option === "object" &&
      option !== null &&
      (option as { readonly id?: unknown }).id === "agent" &&
      typeof (option as { readonly value?: unknown }).value === "string"
    ) {
      return (option as { readonly value: string }).value;
    }
  }
  return undefined;
};

const agentOption = (
  agent: string | undefined,
): { readonly defaultAgent: string } | Record<string, never> =>
  agent !== undefined ? { defaultAgent: agent } : {};

const isAgentDeviceMcp = (
  mcpSession: { readonly endpoint: string; readonly authorizationHeader: string } | undefined,
): mcpSession is { readonly endpoint: string; readonly authorizationHeader: string } =>
  mcpSession !== undefined &&
  mcpSession.endpoint.trim().length > 0 &&
  mcpSession.authorizationHeader.trim().length > 0;

export interface OpenCode2AdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface OpenCode2AdapterDeps {
  /** Client binding, provided by the driver over `server.withConnection`. Defaults to a typed failure (no binding yet). */
  readonly createClient?: (input: {
    readonly directory: string;
    readonly settings: OpenCode2Settings;
  }) => Effect.Effect<OpenCode2SessionClient, OpenCode2AdapterError, Scope.Scope>;
  readonly store?: OpenCode2SessionStore;
  readonly events?: Queue.Queue<ProviderRuntimeEvent>;
}

const deferred = (operation: string, detail: string): ProviderAdapterError =>
  openCode2RequestError(operation, detail);

let eventSequence = 0;
let turnSequence = 0;

const randomEventId = Effect.sync(() => `opencode2-event-${(eventSequence += 1)}`);

/**
 * Build the `opencode2` adapter. Requires `ServerConfig` (cwd +
 * attachmentsDir); the v2 client binding arrives via `deps.createClient`.
 */
export const makeOpenCode2Adapter = Effect.fn("makeOpenCode2Adapter")(function* (
  settings: OpenCode2Settings,
  options?: OpenCode2AdapterOptions | undefined,
  deps?: OpenCode2AdapterDeps | undefined,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode2");
  const serverConfig = yield* ServerConfig;
  void options?.environment;
  const nativeEventLogger = options?.nativeEventLogger;
  const store = deps?.store ?? makeOpenCode2SessionStore();
  const runtimeEvents = deps?.events ?? (yield* Queue.unbounded<ProviderRuntimeEvent>());
  const createClient =
    deps?.createClient ??
    ((_input: { readonly directory: string; readonly settings: OpenCode2Settings }) =>
      Effect.fail(deferred("session.create", "opencode2 client binding is not implemented yet.")));

  const startSession = Effect.fn("startSession")(function* (input: ProviderSessionStartInput) {
    const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
    const agent =
      input.modelSelection !== undefined ? getModelSelectionAgent(input.modelSelection) : undefined;
    // Spawned servers are T3-owned: safe to attach the AgentDevice token.
    // External servers bring their own MCP config, so never forward the
    // token there (mirrors `OpenCode2Server.make`'s spawned/external split).
    const localServer = settings.serverUrl.trim().length === 0;
    const started = yield* startOpenCode2Session(
      store,
      input,
      settings,
      boundInstanceId,
      serverConfig.cwd,
      {
        createClient,
        sameDirectory: (left, right) => Effect.succeed(isSameOpenCode2Directory(left, right)),
        buildPermissionRules: buildOpenCode2PermissionRules,
        // v1 injects instructions per prompt; v2 carries them per session, so
        // re-assert on start (and before non-command turns) from the current
        // selection instead of baking a stale copy.
        instructions: buildRuntimeInstructions({
          harness: "OpenCode2",
          model: input.modelSelection?.model,
        }),
        ...(agent !== undefined ? { defaultAgent: agent } : {}),
        // v1 attaches the `t3-code` remote MCP for AgentDevice threads on
        // spawned servers; external servers bring their own MCP config.
        ...(localServer && isAgentDeviceMcp(mcpSession)
          ? {
              mcpRemote: {
                name: "t3-code",
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
              },
            }
          : {}),
        nowIso: nowIsoDefault,
        onSessionStart: (
          context: OpenCode2SessionContext,
        ): Effect.Effect<void, OpenCode2AdapterError> =>
          Effect.gen(function* () {
            const pumpThreadId = context.session.threadId;
            // `onRawEvent` is a sync callback inside the pump fiber; fork the
            // best-effort native write with the surrounding services instead
            // of `Effect.runFork` (separate-services invocation inside Effect).
            const runFork = Effect.runForkWith(yield* Effect.context<never>());
            // One AbortController per session scope (v1 parity:
            // `OpenCodeAdapter.startEventPump`). The abort finalizer (added
            // after the fork, so LIFO runs it first) aborts the pending
            // subscribe read BEFORE the forked pump is interrupted —
            // `iterator.return()` waits for a parked read, so interrupting
            // first would hang scope close on a live stream.
            // @effect-diagnostics-next-line abortControllerInEffect:off - aborted by a scope finalizer to cancel the event.subscribe read
            const eventsAbortController = new AbortController();
            const subscribeEvents = (): Effect.Effect<
              Awaited<ReturnType<OpenCode2SessionClient["event"]["subscribe"]>>,
              OpenCode2AdapterError
            > =>
              Effect.tryPromise({
                try: () => context.client.event.subscribe({ signal: eventsAbortController.signal }),
                catch: (cause: unknown) =>
                  openCode2RequestError(
                    "event.subscribe",
                    cause instanceof Error ? cause.message : String(cause),
                    cause,
                  ),
              });
            const writeNativeEventBestEffort = (frame: OpenCode2RawEvent): Effect.Effect<void> =>
              Effect.gen(function* () {
                if (nativeEventLogger === undefined) {
                  return;
                }
                yield* nativeEventLogger.write(
                  {
                    observedAt: yield* nowIsoDefault,
                    event: {
                      provider: OPENCODE2_DRIVER_KIND,
                      threadId: pumpThreadId,
                      providerThreadId: context.openCodeSessionId,
                      type: frame.type,
                      payload: frame,
                    },
                  },
                  pumpThreadId,
                );
              }).pipe(Effect.ignore);
            yield* startOpenCode2EventPump(yield* subscribeEvents(), {
              threadId: pumpThreadId,
              events: runtimeEvents,
              store,
              randomEventId,
              nowIso: nowIsoDefault,
              onRawEvent: (frame) => {
                runFork(writeNativeEventBestEffort(frame));
              },
              // Reconnect owns the v1 backoff budgets (250ms base, 5s cap,
              // 64-attempt cap, 10s connection gate) inside the pump; without
              // it a transport drop ends the feed after the first failure.
              // The closure reuses the session-scoped AbortSignal so a
              // resubscribe still tears down with stop (the abort finalizer
              // above rejects the parked read before the pump interrupt).
              resubscribe: () => subscribeEvents(),
            }).pipe(Effect.forkIn(context.sessionScope));
            // Added after the fork: scope finalizers run LIFO, so the pending
            // read aborts before the pump fiber is interrupted (see above).
            yield* Scope.addFinalizer(
              context.sessionScope,
              Effect.sync(() => eventsAbortController.abort()),
            );
            yield* Queue.offer(runtimeEvents, {
              eventId: (yield* randomEventId) as ProviderRuntimeEvent["eventId"],
              provider: OPENCODE2_DRIVER_KIND,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              createdAt: yield* nowIsoDefault,
              type: "session.started",
              payload: { message: "OpenCode 2 session started" },
            } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
            yield* Queue.offer(runtimeEvents, {
              eventId: (yield* randomEventId) as ProviderRuntimeEvent["eventId"],
              provider: OPENCODE2_DRIVER_KIND,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              createdAt: yield* nowIsoDefault,
              type: "thread.started",
              payload: { providerThreadId: context.openCodeSessionId },
            } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
            return context.session;
          }).pipe(
            // The store publishes the context before `onSessionStart` runs, so
            // a pump/subscribe failure would leak a dead context into the
            // store with an unclosed scope. Tear down so a retry starts clean
            // (the in-store remote session is left for the reaper; the losing
            // path only aborts ids it created itself).
            Effect.onError(() =>
              Effect.gen(function* () {
                const failed: OpenCode2SessionContext | undefined = store.get(input.threadId);
                yield* stopOpenCode2Context(context);
                if (failed === context) {
                  store.deleteIfCurrent(context);
                }
              }).pipe(Effect.ignore),
            ),
          ),
      },
    );
    // v1 holds the session at `connecting` until the first live pump frame
    // resolves `firstConnection` (10s budget). The store reports `ready`
    // eagerly, so gate here: a start that never connects fails typed
    // instead of returning a dead-but-ready session.
    const startedContext = store.get(input.threadId);
    if (startedContext !== undefined && startedContext.session.threadId === started.threadId) {
      yield* Deferred.await(startedContext.firstConnection).pipe(
        Effect.timeoutOrElse({
          duration: `${OPENCODE2_CONNECTION_TIMEOUT_MS} millis`,
          orElse: () =>
            Effect.gen(function* () {
              yield* stopOpenCode2Context(startedContext);
              store.deleteIfCurrent(startedContext);
              return yield* openCode2RequestError(
                "event.subscribe",
                "OpenCode 2 event stream did not connect within 10 seconds.",
              );
            }),
        }),
      );
      // A racing start may have replaced this context while the gate
      // was pending: the winner owns the thread, so refuse to hand out
      // the loser's session (the loser is already torn down above).
      const current = store.get(input.threadId);
      if (current === undefined || current !== startedContext) {
        return yield* openCode2SessionClosedError(String(input.threadId));
      }
    }
    return started;
  });

  const sendTurn = Effect.fn("sendTurn")(function* (input: ProviderSendTurnInput) {
    const result = yield* sendOpenCode2Turn(store, runtimeEvents, input, {
      boundInstanceId,
      attachmentsDir: serverConfig.attachmentsDir,
      resolveAttachmentPath: (attachmentInput) => resolveAttachmentPath(attachmentInput),
      instructions: buildRuntimeInstructions({
        harness: "OpenCode2",
        model: input.modelSelection?.model,
      }),
      ...(input.modelSelection !== undefined
        ? agentOption(getModelSelectionAgent(input.modelSelection))
        : {}),
      randomTurnId: Effect.sync(() => `${(turnSequence += 1)}`),
      randomMessageId: Effect.sync(() => `msg_${NodeCrypto.randomUUID()}`),
      randomEventId,
      nowIso: nowIsoDefault,
    });
    return {
      threadId: result.threadId,
      turnId: result.turnId,
      ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
    };
  });

  const interruptTurn = Effect.fn("interruptTurn")(function* (
    threadId: ThreadId,
    turnId?: TurnId | undefined,
  ) {
    yield* interruptOpenCode2Turn(store, threadId, turnId);
  });

  const respondToRequest = Effect.fn("respondToRequest")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    yield* respondToOpenCode2Request(store, runtimeEvents, threadId, requestId, decision, {
      randomEventId,
      nowIso: nowIsoDefault,
    });
  });

  const respondToUserInput = Effect.fn("respondToUserInput")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    yield* respondToOpenCode2UserInput(store, runtimeEvents, threadId, requestId, answers, {
      randomEventId,
      nowIso: nowIsoDefault,
    });
  });

  const stopSession = Effect.fn("stopSession")(function* (threadId: ThreadId) {
    const context = store.get(threadId);
    if (context === undefined) {
      return yield* openCode2SessionNotFoundError(String(threadId));
    }
    const stopped = yield* stopOpenCode2Context(context);
    store.deleteIfCurrent(context);
    if (!stopped) {
      return;
    }
    yield* Queue.offer(runtimeEvents, {
      eventId: (yield* randomEventId) as ProviderRuntimeEvent["eventId"],
      provider: OPENCODE2_DRIVER_KIND,
      providerInstanceId: boundInstanceId,
      threadId,
      createdAt: yield* nowIsoDefault,
      type: "session.exited",
      payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
    } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
  });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    listOpenCode2Sessions(store);

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    hasOpenCode2Session(store, threadId);

  const readThread = Effect.fn("readThread")(function* (threadId: ThreadId) {
    const snapshot = yield* readOpenCode2Thread(store, threadId);
    return {
      threadId: snapshot.threadId,
      turns: snapshot.turns.map((turn) => ({
        id: turn.id as unknown as TurnId,
        items: turn.items,
      })),
    };
  });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    rollbackOpenCode2Thread(store, threadId, numTurns, {
      events: runtimeEvents,
      buildPermissionRules: buildOpenCode2PermissionRules,
      randomEventId,
      nowIso: nowIsoDefault,
    }).pipe(
      Effect.map((snapshot) => ({
        threadId: snapshot.threadId,
        turns: snapshot.turns.map((turn) => ({
          id: turn.id as unknown as TurnId,
          items: turn.items,
        })),
      })),
    );

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    stopAllOpenCode2Contexts(store).pipe(
      Effect.asVoid,
      Effect.andThen(Queue.shutdown(runtimeEvents).pipe(Effect.asVoid)),
    );

  yield* Effect.addFinalizer(() =>
    stopAllOpenCode2Contexts(store).pipe(
      Effect.asVoid,
      Effect.andThen(Queue.shutdown(runtimeEvents).pipe(Effect.asVoid)),
      Effect.ignore,
    ),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: OPENCODE2_DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: true,
    },
    startSession,
    sendTurn,
    compaction: {
      type: "native",
      start: (threadId, modelSelection) =>
        compactOpenCode2Thread(store, threadId, modelSelection, { boundInstanceId }),
    },
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  };
  return adapter;
});
