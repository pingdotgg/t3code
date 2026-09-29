/**
 * The OpenCode 2 runtime behind the `opencode` driver. It talks to the
 * instance's `opencode serve` process through the HTTP client and reads that
 * server's `/api/event` stream, routed here by session id.
 *
 * A turn is one `session.prompt`; the session's next `session.execution.*`
 * terminal ends it. Approvals, questions, subagents, steering, fork, rollback
 * and compaction arrive in later layers, so the capabilities below say no and
 * a permission or form that still reaches a session is refused so the turn
 * cannot hang.
 *
 * @module orchestration-v2/Adapters/OpenCode2AdapterV2
 */
import {
  AbsolutePath,
  Location,
  Model,
  Provider,
  Session,
  type OpenCodeEvent,
} from "@opencode/client/effect";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ServerConfig } from "../../config.ts";
import type {
  OpenCode2Connection,
  OpenCode2Server,
} from "../../provider/opencode2/OpenCode2Server.ts";
import {
  parseOpenCodeModelSlug,
  type OpenCodeRuntimeError,
} from "../../provider/opencodeRuntime.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { providerMessageTextWithAttachmentPaths } from "../AttachmentPrompt.ts";
import type { IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import { openCodeToolTurnItem } from "./OpenCodeToolItems.ts";

const OpenCode2ProviderCapabilities = {
  sessions: {
    // One server serves every location, so one session runtime owns them all.
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
  // Sessions run with every tool allowed; the snapshot offers only Full access.
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  /** Open text and reasoning blocks, keyed `<assistantMessageID>:<kind>:<ordinal>`. */
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  interrupted: boolean;
}

interface OpenBlock {
  readonly block: { readonly assistantMessageID: string; readonly ordinal: number };
  readonly kind: "text" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  active: ActiveTurn | undefined;
}

const protocolError = (detail: string) =>
  new ProviderAdapterProtocolError({ driver: OPENCODE_PROVIDER, detail });
const notYet = (feature: string) => protocolError(`OpenCode 2 ${feature} is not supported yet`);

const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: OPENCODE_PROVIDER,
  nativeId,
  strength,
});

const sessionIdOf = (providerThread: OrchestrationV2ProviderThread) => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return nativeId === undefined || nativeId === null
    ? Effect.fail(protocolError(`Provider thread ${providerThread.id} has no OpenCode session`))
    : Effect.succeed(nativeId);
};

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

export interface OpenCode2AdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly server: OpenCode2Server["Service"];
  readonly idAllocator: IdAllocatorV2Shape;
  readonly serverConfig: ServerConfig["Service"];
}

export function makeOpenCode2Adapter(options: OpenCode2AdapterOptions): ProviderAdapterV2Shape {
  const { idAllocator, instanceId, serverConfig } = options;
  const driver = OPENCODE_PROVIDER;

  const openSession = Effect.fn("OpenCode2Adapter.openSession")(function* (
    input: Parameters<ProviderAdapterV2Shape["openSession"]>[0],
    connection: OpenCode2Connection,
  ) {
    const { client } = connection;
    const now = yield* DateTime.now;
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: input.runtimePolicy.cwd ?? serverConfig.cwd,
      model: input.modelSelection.model,
      capabilities: OpenCode2ProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
    const threads = new Map<string, ThreadState>();
    const emit = (event: ProviderAdapterV2Event) => Queue.offer(events, event).pipe(Effect.asVoid);

    const setSessionStatus = (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null,
    ) =>
      Effect.gen(function* () {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });

    const ordinalOf = (turn: ActiveTurn, nativeId: string) => {
      const known = turn.ordinals.get(nativeId);
      if (known !== undefined) return known;
      const next = turn.nextOrdinal++;
      turn.ordinals.set(nativeId, next);
      return next;
    };

    const itemBase = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      status: OrchestrationV2TurnItem["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
      updatedAt: DateTime.Utc,
    ) => ({
      id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(nativeId),
      parentItemId: null,
      ordinal: ordinalOf(turn, nativeId),
      status,
      title: null,
      startedAt,
      completedAt,
      updatedAt,
    });

    const emitNode = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      kind: OrchestrationV2ExecutionNode["kind"],
      status: OrchestrationV2ExecutionNode["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
    ) =>
      emit({
        type: "node.updated",
        driver,
        node: {
          id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind,
          status,
          countsForRun: false,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(nativeId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        },
      });

    /** One text or reasoning block, re-emitted with its accumulated text on every change. */
    const emitText = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      data: {
        readonly assistantMessageID: string;
        readonly ordinal: number;
        readonly text?: string;
      },
      kind: "text" | "reasoning",
      update: (current: string) => string,
      completed = "text" in data,
    ) {
      const nativeId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      const updatedAt = yield* DateTime.now;
      const entry = turn.texts.get(nativeId) ?? {
        block: data,
        kind,
        startedAt: updatedAt,
        text: "",
      };
      entry.text = update(entry.text);
      if (completed) turn.texts.delete(nativeId);
      else turn.texts.set(nativeId, entry);
      if (entry.text.length === 0) return;
      const status = completed ? "completed" : "running";
      const completedAt = completed ? updatedAt : null;
      const nodeKind = kind === "text" ? "assistant_message" : "reasoning";
      yield* emitNode(state, turn, nativeId, nodeKind, status, entry.startedAt, completedAt);
      const base = itemBase(state, turn, nativeId, status, entry.startedAt, completedAt, updatedAt);
      if (kind === "reasoning") {
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: { ...base, type: "reasoning", text: entry.text, streaming: !completed },
        });
        return;
      }
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver,
        nativeItemId: nativeId,
      });
      const message: OrchestrationV2ConversationMessage = {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: base.nodeId,
        role: "assistant",
        text: entry.text,
        attachments: [],
        streaming: !completed,
        createdAt: entry.startedAt,
        updatedAt,
      };
      yield* emit({ type: "message.updated", driver, message });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          type: "assistant_message",
          messageId,
          text: entry.text,
          streaming: !completed,
        },
      });
    });

    const emitTool = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      id: string,
      status: "running" | "completed" | "failed" | "interrupted",
      result?: { readonly output: string | undefined; readonly metadata: unknown },
    ) {
      const tool = turn.tools.get(id);
      if (tool === undefined) return;
      const updatedAt = yield* DateTime.now;
      const startedAt = turn.startedAt.get(id) ?? updatedAt;
      const completedAt = status === "running" ? null : updatedAt;
      yield* emitNode(state, turn, id, "tool_call", status, startedAt, completedAt);
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: openCodeToolTurnItem(
          itemBase(state, turn, id, status, startedAt, completedAt, updatedAt),
          {
            name: tool.name,
            input: tool.input,
            output: result?.output,
            completedMetadata: status === "completed" ? result?.metadata : undefined,
          },
        ),
      });
    });

    const emitProviderTurn = (
      state: ThreadState,
      turn: ActiveTurn,
      providerTurn: OrchestrationV2ProviderTurn,
    ) => {
      state.providerTurns.set(String(providerTurn.id), providerTurn);
      return emit({
        type: "provider_turn.updated",
        driver,
        threadId: turn.input.threadId,
        providerTurn,
      });
    };

    const finishTurn = Effect.fnUntraced(function* (
      state: ThreadState,
      terminal:
        | { readonly status: "completed" | "interrupted" }
        | { readonly status: "failed"; readonly failure: ReturnType<typeof makeProviderFailure> },
      threadDisposition: "reusable" | "broken" = "reusable",
    ) {
      const turn = state.active;
      if (turn === undefined) return;
      state.active = undefined;
      const completedAt = yield* DateTime.now;
      // Blocks still open when the execution ends are final as they stand.
      for (const open of turn.texts.values()) {
        yield* emitText(state, turn, open.block, open.kind, (text) => text, true);
      }
      for (const id of turn.tools.keys()) {
        yield* emitTool(
          state,
          turn,
          id,
          terminal.status === "completed" ? "completed" : "interrupted",
        );
      }
      yield* emitProviderTurn(state, turn, {
        ...turn.providerTurn,
        status: terminal.status,
        completedAt,
      });
      state.providerThread = {
        ...state.providerThread,
        status: threadDisposition === "broken" ? "error" : "idle",
        updatedAt: completedAt,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
      const anyActive = [...threads.values()].some((candidate) => candidate.active !== undefined);
      yield* setSessionStatus(anyActive ? "running" : "ready", null);
      const base = {
        type: "turn.terminal" as const,
        driver,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        threadDisposition,
      };
      yield* emit(
        terminal.status === "failed"
          ? {
              ...base,
              status: "failed",
              failure: terminal.failure,
              failureItemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
            }
          : { ...base, status: terminal.status, failure: null },
      );
    });

    // Refuses a permission or form so a session never waits on a reply T3 cannot give yet.
    const refuseRequest = (event: EventOf<"permission.asked"> | EventOf<"form.created">) => {
      const refusal =
        event.type === "permission.asked"
          ? client.permission
              .reply({
                sessionID: event.data.sessionID,
                requestID: event.data.id,
                decision: "reject",
                message: "T3 Code cannot answer this request for OpenCode 2 yet.",
              })
              .pipe(Effect.ignore({ log: true }))
          : client.session.form
              .cancel({ sessionID: event.data.form.sessionID, formID: event.data.form.id })
              .pipe(Effect.ignore({ log: true }));
      return Effect.logWarning("Refused an OpenCode request this runtime cannot answer yet.", {
        type: event.type,
      }).pipe(Effect.andThen(refusal));
    };

    const handleEvent = Effect.fnUntraced(function* (event: OpenCodeEvent) {
      if (event.type === "permission.asked" && threads.has(event.data.sessionID)) {
        return yield* refuseRequest(event);
      }
      if (event.type === "form.created" && threads.has(event.data.form.sessionID)) {
        return yield* refuseRequest(event);
      }
      if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return;
      const state = threads.get(event.data.sessionID);
      const turn = state?.active;
      if (state === undefined || turn === undefined) return;
      switch (event.type) {
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.text.ended":
        case "session.reasoning.ended": {
          const data = event.data;
          const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
          return yield* emitText(state, turn, data, kind, (text) =>
            "delta" in data ? text + data.delta : "text" in data ? data.text : text,
          );
        }
        case "session.tool.input.started":
          turn.tools.set(event.data.id, { name: event.data.name, input: {} });
          turn.startedAt.set(event.data.id, yield* DateTime.now);
          return yield* emitTool(state, turn, event.data.id, "running");
        case "session.tool.called": {
          const tool = turn.tools.get(event.data.id);
          if (tool !== undefined) tool.input = event.data.input;
          return yield* emitTool(state, turn, event.data.id, "running");
        }
        case "session.tool.success": {
          const output = textOf(event.data.content);
          yield* emitTool(state, turn, event.data.id, "completed", {
            output,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.tool.failed": {
          const aborted = event.data.error.type === "aborted";
          yield* emitTool(state, turn, event.data.id, aborted ? "interrupted" : "failed", {
            output: event.data.error.message,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.execution.succeeded":
          return yield* finishTurn(state, {
            status: turn.interrupted ? "interrupted" : "completed",
          });
        case "session.execution.interrupted":
          return yield* finishTurn(state, { status: "interrupted" });
        case "session.execution.failed":
          return yield* finishTurn(state, {
            status: "failed",
            failure: makeProviderFailure({
              message: event.data.error.message,
              code: event.data.error.type,
              class: "provider_error",
            }),
          });
        default:
          return;
      }
    });

    // The stream is the only terminal signal, so a lost stream settles every
    // running turn and breaks the session: T3 reopens it for the next turn.
    const failAll = Effect.fnUntraced(function* (message: string) {
      yield* setSessionStatus("error", message);
      for (const state of threads.values()) {
        const failure = makeProviderFailure({ message, class: "transport_error" });
        yield* finishTurn(state, { status: "failed", failure }, "broken");
      }
      yield* Queue.end(events);
    });
    // Subscribed before any session or prompt call, so no event of theirs is missed.
    const stream = yield* connection.events;
    yield* stream.pipe(
      Stream.runForEach(handleEvent),
      Effect.matchCauseEffect({
        onSuccess: () => failAll("The OpenCode event stream ended."),
        onFailure: () => failAll("The OpenCode event stream failed."),
      }),
      Effect.forkScoped,
    );

    const register = (providerThread: OrchestrationV2ProviderThread, sessionId: string) => {
      const existing = threads.get(sessionId);
      if (existing !== undefined) {
        existing.providerThread = providerThread;
        return providerThread;
      }
      threads.set(sessionId, { providerThread, providerTurns: new Map(), active: undefined });
      return providerThread;
    };

    const prompt = (turnInput: ProviderAdapterV2TurnInput) => {
      const text = providerMessageTextWithAttachmentPaths({
        text: turnInput.message.text,
        attachments: turnInput.message.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
      }).trim();
      const instructions = buildRuntimeInstructions({
        harness: "OpenCode",
        model: turnInput.modelSelection.model,
      });
      return `${text}\n\n${instructions}`;
    };

    const runtime: ProviderAdapterV2SessionRuntime = {
      instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      get providerSession() {
        return session;
      },
      events: Stream.fromQueue(events),
      ensureThread: (threadInput) =>
        Effect.gen(function* () {
          if (threadInput.existingProviderThread?.nativeThreadRef != null) {
            return yield* runtime.resumeThread({
              providerThread: threadInput.existingProviderThread,
            });
          }
          const parsed = parseOpenCodeModelSlug(threadInput.modelSelection.model);
          const created = yield* client.session.create({
            location: Location.PublicRef.make({
              directory: AbsolutePath.make(threadInput.runtimePolicy.cwd ?? serverConfig.cwd),
            }),
            ...(parsed === null
              ? {}
              : {
                  model: Model.Ref.make({
                    providerID: Provider.ID.make(parsed.providerID),
                    id: Model.ID.make(parsed.modelID),
                  }),
                }),
            // Full access is the only mode the snapshot offers until layer 5.
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          });
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            ...(threadInput.existingProviderThread ?? {
              id: idAllocator.derive.providerThread({ driver, nativeThreadId: created.id }),
              driver,
              providerInstanceId: instanceId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
            }),
            providerSessionId: input.providerSessionId,
            nativeThreadRef: ref(created.id),
            nativeConversationHeadRef: null,
            status: "idle",
            updatedAt: createdAt,
          };
          return register(providerThread, created.id);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterEnsureThreadError({
                driver,
                threadId: threadInput.threadId,
                cause,
              }),
          ),
        ),
      resumeThread: (threadInput) =>
        Effect.gen(function* () {
          const sessionId = yield* sessionIdOf(threadInput.providerThread);
          // 1.x session ids survive the upgrade; a server without this session
          // fails the resume, so T3 recreates the thread with a handoff.
          yield* client.session.get({ sessionID: Session.ID.make(sessionId) });
          return register(
            {
              ...threadInput.providerThread,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: yield* DateTime.now,
            },
            sessionId,
          );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: threadInput.providerThread.id,
                cause,
              }),
          ),
        ),
      startTurn: (turnInput) =>
        Effect.gen(function* () {
          const sessionId = yield* sessionIdOf(turnInput.providerThread);
          const state = threads.get(sessionId);
          if (state === undefined) {
            return yield* protocolError(`OpenCode session ${sessionId} is not registered`);
          }
          if (state.active !== undefined) {
            return yield* protocolError(`OpenCode session ${sessionId} already has an active turn`);
          }
          const startedAt = yield* DateTime.now;
          const nativeTurnId = `${sessionId}:attempt:${turnInput.attemptId}`;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: ref(nativeTurnId, "weak"),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveTurn = {
            input: turnInput,
            providerTurn,
            texts: new Map(),
            tools: new Map(),
            startedAt: new Map(),
            ordinals: new Map(),
            nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
            interrupted: false,
          };
          state.active = turn;
          yield* emitProviderTurn(state, turn, providerTurn);
          state.providerThread = {
            ...state.providerThread,
            status: "active",
            firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
            updatedAt: startedAt,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: state.providerThread,
          });
          yield* setSessionStatus("running", null);
          yield* client.session
            .prompt({ sessionID: Session.ID.make(sessionId), text: prompt(turnInput) })
            .pipe(
              Effect.tapError((cause) =>
                state.active === turn
                  ? finishTurn(state, {
                      status: "failed",
                      failure: makeProviderFailure({ cause, class: "provider_error" }),
                    })
                  : Effect.void,
              ),
            );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterTurnStartError({
                driver,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause,
              }),
          ),
        ),
      steerTurn: (steerInput) =>
        Effect.fail(
          new ProviderAdapterSteerRunUnsupportedError({
            driver,
            providerThreadId: steerInput.providerThread.id,
          }),
        ),
      interruptTurn: (interruptInput) =>
        Effect.gen(function* () {
          const sessionId = yield* sessionIdOf(interruptInput.providerThread);
          const turn = threads.get(sessionId)?.active;
          if (turn === undefined || turn.providerTurn.id !== interruptInput.providerTurnId) return;
          turn.interrupted = true;
          // The session answers with `session.execution.interrupted`, which ends the turn.
          yield* client.session.interrupt({ sessionID: Session.ID.make(sessionId) });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterInterruptError({
                driver,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause,
              }),
          ),
        ),
      unloadThread: ({ providerThread }) =>
        Effect.sync(() => {
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          if (
            nativeId !== undefined &&
            nativeId !== null &&
            threads.get(nativeId)?.active === undefined
          ) {
            threads.delete(nativeId);
          }
        }),
      respondToRuntimeRequest: (requestInput) =>
        Effect.fail(
          new ProviderAdapterRuntimeRequestResponseError({
            driver,
            requestId: requestInput.requestId,
            cause: notYet("answering runtime requests"),
          }),
        ),
      readThreadSnapshot: ({ providerThread }) =>
        Effect.fail(
          new ProviderAdapterReadThreadSnapshotError({
            driver,
            providerThreadId: providerThread.id,
            cause: notYet("history snapshots"),
          }),
        ),
      rollbackThread: (rollbackInput) =>
        Effect.fail(
          new ProviderAdapterRollbackThreadError({
            driver,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
            cause: notYet("rollback"),
          }),
        ),
      forkThread: (forkInput) =>
        Effect.fail(
          new ProviderAdapterForkThreadError({
            driver,
            providerThreadId: forkInput.sourceProviderThread.id,
            cause: notYet("fork"),
          }),
        ),
    };
    return runtime;
  });

  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(OpenCode2ProviderCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    // The session borrows the instance's server for as long as it is open, so a
    // spawned server is not idle-stopped under a long tool call.
    openSession: (input) =>
      Effect.gen(function* () {
        const lent = yield* Deferred.make<OpenCode2Connection, OpenCodeRuntimeError>();
        yield* options.server
          .withConnection((connection) =>
            Deferred.succeed(lent, connection).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(
            Effect.catch((error) => Deferred.fail(lent, error)),
            Effect.forkScoped,
          );
        return yield* openSession(input, yield* Deferred.await(lent));
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  };
}
