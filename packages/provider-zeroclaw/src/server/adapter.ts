// ZeroClaw adapter. One RPC connection hosts every thread of a provider session.
import {
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  AGENT_MISMATCH_MESSAGE,
  DEFAULT_RESTORE_MESSAGE,
  NO_AGENT_MESSAGE,
  ZEROCLAW_CAPABILITIES,
  ZEROCLAW_PROVIDER,
  approvalDecisionToZeroClaw,
  sessionUpdateToEvents,
  splitModelSlug,
  type ProjectionState,
} from "./projection.ts";
import {
  INITIALIZE_PARAMS,
  UNSUPPORTED_REQUEST_ERROR,
  decodeSessionNewResult,
  decodeAgentsListResult,
  decodeSessionMessagesResult,
  decodeSessionUpdate,
} from "./protocol.ts";
import { makeZeroClawRpcConnection, type ZeroClawRpcConnection } from "./rpc.ts";
import type { ZeroClawSettings } from "../settings.ts";

export interface ZeroClawAdapterV2Options {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2SessionRuntime["instanceId"];
  readonly settings: ZeroClawSettings;
  readonly resolveSocketPath: (
    settings: ZeroClawSettings,
  ) => Effect.Effect<string, ProviderAdapter.ProviderAdapterV2Error>;
  readonly resolveAgentAlias?: (input: {
    readonly requested: string | undefined;
    readonly agents: ReadonlyArray<string>;
  }) => string | undefined;
  readonly connect?: (
    socketPath: string,
  ) => Effect.Effect<ZeroClawRpcConnection, ProviderAdapter.ProviderAdapterV2Error, Scope.Scope>;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  agentAlias: string;
  /** Workspace the daemon session was opened in; a reconnect reopens it there. */
  cwd: string;
  appliedModel: string | undefined;
  activeTurn: OrchestrationV2ProviderTurn | undefined;
  text: Map<"assistant" | "reasoning", string>;
  projection: ProjectionState;
}

const TEXT_FLUSH = Duration.millis(50);

function protocolError(detail: string) {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ZEROCLAW_PROVIDER,
    detail,
  });
}

function providerRef(nativeId: string) {
  return { driver: ZEROCLAW_PROVIDER, nativeId, strength: "strong" as const };
}

export const makeZeroClawAdapterV2 = Effect.fn("makeZeroClawAdapterV2")((
  options: ZeroClawAdapterV2Options,
) => {
  const openSession = Effect.fn("ZeroClawAdapter.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    // Provider requests must outlive `startTurn`: the orchestrator returns as
    // soon as the prompt is accepted, but the JSON-RPC response can arrive later.
    const sessionScope = yield* Effect.scope;
    const socketPath = yield* options.resolveSocketPath(options.settings);
    // Filled in once the session map exists. The transport calls it after a
    // reconnect, before it writes anything new.
    const reattach: { current: Effect.Effect<void> } = { current: Effect.void };
    const connection = yield* (
      options.connect ??
      ((path: string) =>
        // Reconnect: a daemon reload restarts its process and drops the socket.
        makeZeroClawRpcConnection({
          socketPath: path,
          reconnect: { onReconnect: () => reattach.current },
        }).pipe(Effect.mapError((cause) => protocolError(cause.message))))
    )(socketPath);

    yield* connection.request("initialize", INITIALIZE_PARAMS).pipe(
      Effect.forkChild,
      Effect.flatMap(Fiber.join),
      Effect.mapError((cause) => protocolError(cause.message)),
    );

    // Elicitation is not advertised, so the daemon should send no requests.
    // Refuse any that arrive rather than leave the daemon waiting on a timeout.
    yield* Stream.fromQueue(connection.inboundRequests).pipe(
      Stream.runForEach((inbound) =>
        connection
          .respond(inbound.id, { _tag: "error", error: UNSUPPORTED_REQUEST_ERROR })
          .pipe(Effect.ignore),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const threads = new Map<string, ThreadState>();
    /** Approval request id → the session that raised it; session/approve needs both. */
    const approvalSessions = new Map<string, string>();
    const now = yield* DateTime.now;
    /** The daemon runs every tool call of a session in the workspace it was opened with. */
    const sessionCwd = input.runtimePolicy.cwd ?? "/";

    const providerSession: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver: ZEROCLAW_PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      cwd: sessionCwd,
      model: input.modelSelection.model,
      capabilities: ZEROCLAW_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };

    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event);

    const emitContextUsage = Effect.fnUntraced(function* (
      thread: ThreadState,
      usage: { readonly usedTokens: number; readonly maxTokens?: number },
      now: DateTime.Utc,
    ) {
      const activeTurn = thread.activeTurn;
      if (activeTurn === undefined) return;
      const providerTurn: OrchestrationV2ProviderTurn = {
        ...activeTurn,
        tokenUsage: {
          usedTokens: usage.usedTokens,
          ...(usage.maxTokens === undefined ? {} : { maxTokens: usage.maxTokens }),
          updatedAt: DateTime.formatIso(now),
        },
      };
      thread.activeTurn = providerTurn;
      yield* emit({
        type: "provider_turn.updated",
        driver: ZEROCLAW_PROVIDER,
        ...(thread.providerThread.appThreadId === null
          ? {}
          : { threadId: thread.providerThread.appThreadId }),
        providerTurn,
      });
    });

    const flushText = Effect.fnUntraced(function* (thread: ThreadState) {
      for (const [kind, text] of thread.text) {
        if (text.length === 0) continue;
        const projected = sessionUpdateToEvents(thread.projection, {
          type: kind === "assistant" ? "agent_message_chunk" : "agent_thought_chunk",
          text,
        });
        thread.text.set(kind, "");
        for (const event of projected.events) yield* emit(event);
      }
    });

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(TEXT_FLUSH);
        const now = yield* DateTime.now;
        for (const thread of threads.values()) {
          thread.projection.now = now;
          yield* flushText(thread);
        }
      }
    }).pipe(Effect.forkScoped);

    // A daemon reload drops the socket and restarts the process. The transport
    // reopens it and calls this before writing anything new; the sessions do
    // not survive the restart, so reattach each one by its id.
    reattach.current = Effect.gen(function* () {
      yield* connection.request("initialize", INITIALIZE_PARAMS);
      for (const [sessionId, thread] of threads) {
        yield* connection
          .request("session/new", {
            agent_alias: thread.agentAlias,
            cwd: thread.cwd,
            session_id: sessionId,
            keep_siblings: true,
          })
          .pipe(Effect.orDie);
        const model = thread.appliedModel;
        if (model === undefined) continue;
        const split = splitModelSlug(model);
        if (split === null) continue;
        yield* connection.request("session/configure", {
          session_id: sessionId,
          overrides: { model: split.model, model_provider: split.modelProvider },
        });
      }
    }).pipe(Effect.orDie);

    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runForEach((notification) =>
        Effect.gen(function* () {
          if (notification.method !== "session/update") return;
          const params = notification.params;
          if (typeof params !== "object" || params === null) return;
          const sessionId =
            "sessionId" in params && typeof params.sessionId === "string"
              ? params.sessionId
              : "session_id" in params && typeof params.session_id === "string"
                ? params.session_id
                : undefined;
          if (sessionId === undefined) return;
          const thread = threads.get(sessionId);
          if (thread === undefined) return;
          const update = yield* decodeSessionUpdate(params).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (update === undefined || !("type" in update)) return;
          if (update.type === "agent_message_chunk" || update.type === "agent_thought_chunk") {
            if (!("text" in update)) return;
            const kind = update.type === "agent_message_chunk" ? "assistant" : "reasoning";
            thread.text.set(kind, `${thread.text.get(kind) ?? ""}${update.text}`);
            return;
          }
          const now = yield* DateTime.now;
          thread.projection.now = now;
          yield* flushText(thread);
          if (
            update.type === "approval_request" &&
            "requestId" in update &&
            typeof update.requestId === "string"
          ) {
            approvalSessions.set(update.requestId, sessionId);
          }
          if (update.type === "turn_complete" && "outcome" in update) {
            const activeTurn = thread.activeTurn;
            if (activeTurn !== undefined)
              thread.activeTurn = {
                ...activeTurn,
                status:
                  update.outcome === "failed"
                    ? "failed"
                    : update.outcome === "cancelled"
                      ? "cancelled"
                      : "completed",
                completedAt: now,
              };
          }
          const projected = sessionUpdateToEvents(thread.projection, update);
          for (const event of projected.events) yield* emit(event);
          if (projected.tokenUsage !== undefined) {
            yield* emitContextUsage(thread, projected.tokenUsage, now);
          }
        }),
      ),
      Effect.forkScoped,
    );

    const request = (method: string, params: unknown, timeoutMs?: number) =>
      connection.request(method, params, timeoutMs).pipe(
        Effect.forkChild,
        Effect.flatMap(Fiber.join),
        Effect.mapError((cause) => protocolError(cause.message)),
      );

    const resolveAgent = Effect.fn("ZeroClawAdapter.resolveAgent")(function* (
      selection?: ModelSelection,
    ) {
      const { agents } = yield* request("agents/list", {}).pipe(
        Effect.flatMap(decodeAgentsListResult),
        Effect.mapError((cause) => protocolError(cause.message)),
      );
      const known = agents.filter((agent) => agent.enabled !== false).map((agent) => agent.alias);
      const requested =
        selection === undefined
          ? undefined
          : getModelSelectionStringOptionValue(selection, "agent");
      const alias =
        options.resolveAgentAlias !== undefined
          ? options.resolveAgentAlias({ requested, agents: known })
          : requested?.trim() ||
            options.settings.defaultAgentAlias.trim() ||
            (known.length === 1 ? known[0] : undefined);
      if (alias === undefined || !known.includes(alias))
        return yield* protocolError(NO_AGENT_MESSAGE);
      return alias;
    });

    const openThread = Effect.fn("ZeroClawAdapter.openThread")(function* (
      threadId: ThreadId,
      agentAlias: string,
      cwd: string,
      sessionId?: string,
    ) {
      const created = yield* connection
        .request("session/new", {
          agent_alias: agentAlias,
          cwd,
          keep_siblings: true,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        })
        .pipe(
          Effect.forkChild,
          Effect.flatMap(Fiber.join),
          Effect.mapError((cause) => protocolError(cause.message)),
        );
      const decoded = yield* decodeSessionNewResult(created).pipe(
        Effect.mapError((cause) => protocolError(cause.message)),
      );
      const createdAt = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make(`zc-${decoded.sessionId}`),
        driver: ZEROCLAW_PROVIDER,
        providerInstanceId: options.instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: providerRef(decoded.sessionId),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
      };
      threads.set(decoded.sessionId, {
        providerThread,
        agentAlias: decoded.agentAlias ?? agentAlias,
        cwd,
        appliedModel: undefined,
        activeTurn: undefined,
        text: new Map(),
        projection: {
          identity: {
            threadId,
            runId: null as never,
            nodeId: NodeId.make(`zc-node-${decoded.sessionId}`),
            providerThreadId: providerThread.id,
            providerTurnId: ProviderTurnId.make(`zc-turn-${decoded.sessionId}`),
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            ordinal: 1,
          },
          now: createdAt,
          items: new Map(),
          tools: new Map(),
          subagents: new Map(),
          text: { assistant: "", reasoning: "", settled: "" },
          segment: 0,
          nextOrdinal: 0,
        },
      });
      return providerThread;
    });

    const sessionIdOf = (thread: OrchestrationV2ProviderThread) =>
      thread.nativeThreadRef?.nativeId ?? undefined;

    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: options.instanceId,
      driver: ZEROCLAW_PROVIDER,
      providerSessionId: input.providerSessionId,
      providerSession,
      events: Stream.fromQueue(events),
      hasPendingBackgroundWork: Effect.succeed(false),
      ensureThread: Effect.fn("ZeroClawAdapter.ensureThread")(function* (ensureInput) {
        const agent = yield* resolveAgent(ensureInput.modelSelection);
        return yield* openThread(
          ensureInput.threadId,
          agent,
          ensureInput.runtimePolicy.cwd ?? sessionCwd,
        );
      }),
      resumeThread: Effect.fn("ZeroClawAdapter.resumeThread")(function* (resumeInput) {
        const sessionId = sessionIdOf(resumeInput.providerThread);
        if (sessionId === undefined) return yield* protocolError("Thread has no ZeroClaw session.");
        const existing = threads.get(sessionId);
        const agent = existing?.agentAlias ?? (yield* resolveAgent(resumeInput.modelSelection));
        return yield* openThread(
          resumeInput.threadId ??
            resumeInput.providerThread.appThreadId ??
            ThreadId.make("resumed"),
          agent,
          resumeInput.runtimePolicy?.cwd ?? sessionCwd,
          sessionId,
        );
      }),
      startTurn: Effect.fn("ZeroClawAdapter.startTurn")(function* (turnInput) {
        if (turnInput.message.attachments.length > 0) {
          return yield* protocolError("ZeroClaw does not support message attachments.");
        }
        const sessionId = sessionIdOf(turnInput.providerThread);
        const thread = sessionId === undefined ? undefined : threads.get(sessionId);
        if (thread === undefined) return yield* protocolError("Thread is not open.");
        const requestedAgent = getModelSelectionStringOptionValue(
          turnInput.modelSelection,
          "agent",
        );
        if (
          requestedAgent !== undefined &&
          requestedAgent.length > 0 &&
          requestedAgent !== thread.agentAlias
        ) {
          return yield* protocolError(AGENT_MISMATCH_MESSAGE(thread.agentAlias, requestedAgent));
        }
        const model = turnInput.modelSelection.model;
        if (model !== (thread.appliedModel ?? "default")) {
          if (model === "default") {
            if (thread.appliedModel !== undefined) {
              return yield* protocolError(DEFAULT_RESTORE_MESSAGE(thread.appliedModel));
            }
          } else {
            const split = splitModelSlug(model);
            if (split === null) return yield* protocolError(`Cannot switch to model \`${model}\`.`);
            yield* request("session/configure", {
              session_id: sessionId,
              overrides: { model: split.model, model_provider: split.modelProvider },
            });
            thread.appliedModel = model;
          }
        }
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: ProviderTurnId.make(`zc-turn-${sessionId}-${turnInput.providerTurnOrdinal}`),
          providerThreadId: thread.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: null,
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        thread.activeTurn = providerTurn;
        thread.text.clear();
        thread.projection = {
          ...thread.projection,
          identity: {
            ...thread.projection.identity,
            runId: turnInput.runId,
            nodeId: turnInput.rootNodeId,
            providerTurnId: providerTurn.id,
            ordinal: turnInput.runOrdinal,
            appThread: turnInput.appThread,
            modelSelection: turnInput.modelSelection,
          },
          now: startedAt,
          items: new Map(),
          tools: new Map(),
          subagents: new Map(),
          nextOrdinal: 0,
          text: { assistant: "", reasoning: "", settled: "" },
          segment: 0,
        };
        yield* emit({
          type: "provider_turn.updated",
          driver: ZEROCLAW_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn,
        });
        // ZeroClaw's session/prompt is asynchronous: completion is signaled by
        // session/update(turn_complete), while its JSON-RPC response may arrive
        // much later. The response fiber must outlive startTurn, so bind it to
        // the provider session scope rather than the orchestration caller.
        yield* connection
          .request("session/prompt", { session_id: sessionId, prompt: turnInput.message.text }, 0)
          .pipe(
            Effect.mapError((cause) => protocolError(cause.message)),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                if (
                  thread.activeTurn?.id !== providerTurn.id ||
                  thread.activeTurn.status !== "running"
                )
                  return;
                yield* flushText(thread);
                const failed = sessionUpdateToEvents(thread.projection, {
                  type: "turn_complete",
                  outcome: "failed",
                  content: cause.message,
                });
                for (const event of failed.events) yield* emit(event);
                if (thread.activeTurn !== undefined) {
                  thread.activeTurn = {
                    ...thread.activeTurn,
                    status: "failed",
                    completedAt: yield* DateTime.now,
                  };
                }
              }),
            ),
            Effect.forkIn(sessionScope),
            Effect.asVoid,
          );
      }),
      steerTurn: Effect.fn("ZeroClawAdapter.steerTurn")(function* (steerInput) {
        if (steerInput.message.attachments.length > 0) {
          return yield* protocolError("ZeroClaw does not support message attachments.");
        }
        const sessionId = sessionIdOf(steerInput.providerThread);
        if (sessionId === undefined) return yield* protocolError("Thread is not open.");
        yield* request("session/steer", {
          session_id: sessionId,
          content: steerInput.message.text,
        });
      }),
      interruptTurn: Effect.fn("ZeroClawAdapter.interruptTurn")(function* (interruptInput) {
        const sessionId = sessionIdOf(interruptInput.providerThread);
        if (sessionId === undefined) return yield* protocolError("Thread is not open.");
        yield* request("session/cancel", { session_id: sessionId });
      }),
      respondToRuntimeRequest: Effect.fn("ZeroClawAdapter.respondToRuntimeRequest")(
        function* (responseInput) {
          if (responseInput.decision === undefined) {
            // Only approvals become runtime requests; elicitation is not advertised.
            return yield* protocolError(
              "ZeroClaw runtime requests only accept approval decisions.",
            );
          }
          const sessionId = approvalSessions.get(responseInput.requestId);
          if (sessionId === undefined) {
            return yield* protocolError(
              `No pending ZeroClaw approval for request ${responseInput.requestId}.`,
            );
          }
          approvalSessions.delete(responseInput.requestId);
          const decision = approvalDecisionToZeroClaw(responseInput.decision);
          yield* request("session/approve", {
            session_id: sessionId,
            request_id: responseInput.requestId,
            decision,
          });
          if (responseInput.decision === "cancel") {
            yield* request("session/cancel", { session_id: sessionId });
          }
        },
      ),
      readThreadSnapshot: Effect.fn("ZeroClawAdapter.readThreadSnapshot")(
        function* (snapshotInput) {
          const sessionId = sessionIdOf(snapshotInput.providerThread);
          if (sessionId === undefined) return yield* protocolError("Thread is not open.");
          const raw = yield* request("session/messages", { session_id: sessionId });
          const { messages: entries } = yield* decodeSessionMessagesResult(raw).pipe(
            Effect.mapError((cause) => protocolError(cause.message)),
          );
          const messages = entries.filter(
            (entry) => entry.kind === undefined || entry.kind === "message",
          );
          const conversation: OrchestrationV2ConversationMessage[] = messages.map(
            (message, index) => ({
              createdBy: message.role === "user" ? "user" : "agent",
              creationSource: "provider",
              id: MessageId.make(`zc-snapshot-${sessionId}-${index}`),
              threadId: snapshotInput.providerThread.appThreadId ?? ThreadId.make("snapshot"),
              runId: null,
              nodeId: null,
              role:
                message.role === "user"
                  ? "user"
                  : message.role === "system"
                    ? "system"
                    : "assistant",
              text: message.content ?? "",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            }),
          );
          return {
            providerThread: snapshotInput.providerThread,
            providerTurns: [],
            messages: conversation,
            runtimeRequests: [],
          };
        },
      ),
      unloadThread: Effect.fn("ZeroClawAdapter.unloadThread")(function* (unloadInput) {
        const sessionId = sessionIdOf(unloadInput.providerThread);
        if (sessionId === undefined) return;
        threads.delete(sessionId);
        yield* request("session/close", { session_id: sessionId });
      }),
      rollbackThread: () => Effect.fail(protocolError("ZeroClaw does not support rollback.")),
      forkThread: () => Effect.fail(protocolError("ZeroClaw does not support fork.")),
    };

    return runtime;
  });

  return Effect.succeed(
    ProviderAdapter.ProviderAdapterV2.of({
      instanceId: options.instanceId,
      driver: ZEROCLAW_PROVIDER,
      getCapabilities: Effect.fn("ZeroClawAdapter.getCapabilities")(() =>
        Effect.succeed(ZEROCLAW_CAPABILITIES),
      ),
      planSelectionTransition: Effect.fn("ZeroClawAdapter.planSelectionTransition")(() =>
        Effect.succeed(turnScopedSelectionTransition()),
      ),
      openSession,
    }),
  );
});
