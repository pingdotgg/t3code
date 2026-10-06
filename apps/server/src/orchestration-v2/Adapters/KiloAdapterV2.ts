import type { Event, Part, PermissionRequest, QuestionRequest } from "@kilocode/sdk/v2";
import {
  ProviderDriverKind,
  RuntimeRequestId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { toOpenCodeFileParts } from "../../provider/opencodeRuntime.ts";
import * as KiloRuntime from "../../provider/kilo/KiloRuntime.ts";
import { KiloSessionError, type KiloSessionRef } from "../../provider/kilo/KiloSessionClient.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Adapter from "../ProviderAdapter.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "../SubagentProjection.ts";
import { openCodePermissionRules } from "./OpenCodeAdapterV2.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { openCodeToolTurnItem } from "./OpenCodeToolItems.ts";

const isKiloRuntimeError = Schema.is(KiloRuntime.KiloRuntimeError);

const isKiloSessionError = Schema.is(KiloSessionError);

export const KILO_PROVIDER = ProviderDriverKind.make("kilo");

export const kiloCapabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
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
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
};

const error = (detail: string) =>
  new Adapter.ProviderAdapterProtocolError({ driver: KILO_PROVIDER, detail });
const nativeRef = (nativeId: string) => ({
  driver: KILO_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const wire = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new Adapter.ProviderAdapterProtocolError({
          driver: KILO_PROVIDER,
          // These typed messages contain no raw transport responses or credentials.
          detail:
            isKiloRuntimeError(cause) || isKiloSessionError(cause)
              ? cause.message
              : "Kilo request failed; the operation was not retried",
          cause,
        }),
    ),
  );

// Native tool rules are approval policy, not process or MCP-start isolation.
const permissions = (policy: Adapter.ProviderAdapterV2RuntimePolicy) => {
  const rules = openCodePermissionRules(policy);
  // Kilo re-appends session denies in Plan and inherits them into children. OpenCode's
  // temporary deny seeds would therefore override later ask rules permanently.
  const effective = rules.filter(
    (rule, index) =>
      !rules
        .slice(index + 1)
        .some((later) => later.permission === rule.permission && later.pattern === rule.pattern),
  );
  // Kilo 7.8.3 inherits denies, not asks, into child sessions and provides no pre-start
  // child policy hook. Do not allow a child to escape the selected T3 approval policy.
  const unrestricted =
    effective.length === 1 &&
    effective[0]?.permission === "*" &&
    effective[0]?.pattern === "*" &&
    effective[0]?.action === "allow";
  if (!unrestricted || policy.interactionMode !== "default")
    effective.push({ permission: "task", pattern: "*", action: "deny" });
  return effective;
};

type KiloInteraction =
  | { readonly id: string; readonly permission: string; readonly patterns: ReadonlyArray<string> }
  | {
      readonly id: string;
      readonly questions: ReadonlyArray<{
        readonly header: string;
        readonly question: string;
        readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
        readonly multiple?: boolean | undefined;
        readonly custom?: boolean | undefined;
      }>;
    };

/** The runtime request, node and turn item that present a native Kilo permission or question. */
export const kiloInteraction = (input: {
  readonly native: KiloInteraction;
  readonly requestId: RuntimeRequestId;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly nativeRef: NonNullable<OrchestrationV2ExecutionNode["nativeItemRef"]>;
  readonly threadId: OrchestrationV2ExecutionNode["threadId"];
  readonly runId: OrchestrationV2ExecutionNode["runId"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerSessionId: Adapter.ProviderAdapterV2SessionRuntime["providerSessionId"];
  readonly ordinal: number;
  readonly at: DateTime.Utc;
}) => {
  const { native, at } = input;
  const question = "questions" in native;
  const kind = question
    ? "user_input"
    : /edit|write|patch/.test(native.permission)
      ? "file-change"
      : /read|glob|grep/.test(native.permission)
        ? "file-read"
        : "command";
  const runtime: OrchestrationV2RuntimeRequest = {
    id: input.requestId,
    nodeId: input.nodeId,
    providerTurnId: input.providerTurnId,
    nativeRequestRef: input.nativeRef,
    kind,
    status: "pending",
    responseCapability: { type: "live", providerSessionId: input.providerSessionId },
    createdAt: at,
    resolvedAt: null,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: input.nodeId,
    threadId: input.threadId,
    runId: input.runId,
    parentNodeId: input.rootNodeId,
    rootNodeId: input.rootNodeId,
    kind: question ? "user_input_request" : "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeRef,
    runtimeRequestId: input.requestId,
    checkpointScopeId: null,
    startedAt: at,
    completedAt: null,
  };
  const base = {
    id: input.turnItemId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeRef,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "waiting" as const,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    requestId: input.requestId,
  };
  const turnItem: OrchestrationV2TurnItem = question
    ? {
        ...base,
        type: "user_input_request",
        title: "Kilo question",
        questions: native.questions.map((q, index) => ({
          id: String(index),
          header: q.header,
          question: q.question,
          options: q.options,
          multiSelect: q.multiple ?? false,
          allowCustomAnswer: q.custom ?? true,
        })),
      }
    : {
        ...base,
        type: "approval_request",
        title: native.permission,
        requestKind: kind === "user_input" ? "command" : kind,
        prompt: native.patterns.join("\n"),
      };
  return { runtime, node, turnItem };
};

/** Native answers in question order, or undefined when any question is unanswered. */
export const kiloQuestionAnswers = (
  questions: ReadonlyArray<unknown>,
  answers: NonNullable<Adapter.ProviderAdapterV2RuntimeRequestResponseInput["answers"]>,
) => {
  const native = questions.map((_, index) => {
    const answer = answers[String(index)];
    return typeof answer === "string"
      ? [answer]
      : Array.isArray(answer) && answer.every((value) => typeof value === "string")
        ? answer
        : [];
  });
  return native.some((answer) => answer.length === 0) ? undefined : native;
};

export const kiloPermissionReply = (
  decision: NonNullable<Adapter.ProviderAdapterV2RuntimeRequestResponseInput["decision"]>,
) =>
  decision === "accept"
    ? ("once" as const)
    : decision === "acceptForSession" || decision === "acceptAlways"
      ? ("always" as const)
      : ("reject" as const);

/** The execution node for the turn item of an assistant text, reasoning or tool part. */
export const kiloPartNode = (
  item: Pick<
    OrchestrationV2ExecutionNode,
    | "threadId"
    | "runId"
    | "status"
    | "providerThreadId"
    | "providerTurnId"
    | "nativeItemRef"
    | "startedAt"
    | "completedAt"
  > & { readonly nodeId: OrchestrationV2ExecutionNode["id"] },
  rootNodeId: OrchestrationV2ExecutionNode["id"],
  kind: "assistant_message" | "reasoning" | "tool_call",
): OrchestrationV2ExecutionNode => ({
  id: item.nodeId,
  threadId: item.threadId,
  runId: item.runId,
  parentNodeId: rootNodeId,
  rootNodeId,
  kind,
  status: item.status,
  countsForRun: false,
  providerThreadId: item.providerThreadId,
  providerTurnId: item.providerTurnId,
  nativeItemRef: item.nativeItemRef,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: item.startedAt,
  completedAt: item.completedAt,
});

interface KiloRecords {
  readonly driver: ProviderDriverKind;
  readonly emit: (event: Adapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly nodes: ReadonlyMap<string, OrchestrationV2ExecutionNode>;
  readonly items: ReadonlyMap<string, OrchestrationV2TurnItem>;
}

/** Resolves or cancels a runtime request together with the node and item that present it. */
export const kiloSettleRequest = Effect.fnUntraced(function* (
  records: KiloRecords,
  request: OrchestrationV2RuntimeRequest,
  turnItemId: OrchestrationV2TurnItem["id"],
  outcome: "resolved" | "cancelled",
) {
  const at = yield* DateTime.now;
  const status = outcome === "resolved" ? "completed" : "interrupted";
  const runtime = { ...request, status: outcome, resolvedAt: at };
  yield* records.emit({
    type: "runtime_request.updated",
    driver: records.driver,
    runtimeRequest: runtime,
  });
  const node = records.nodes.get(request.nodeId);
  if (node)
    yield* records.emit({
      type: "node.updated",
      driver: records.driver,
      node: { ...node, status, completedAt: at },
    });
  const item = records.items.get(turnItemId);
  if (item)
    yield* records.emit({
      type: "turn_item.updated",
      driver: records.driver,
      turnItem: { ...item, status, completedAt: at, updatedAt: at },
    });
  return runtime;
});

/** Ends the nodes, turn items and streaming messages a provider turn left open. */
export const kiloEndOpenRecords = Effect.fnUntraced(function* (
  records: KiloRecords,
  messages: Map<string, OrchestrationV2ConversationMessage>,
  providerTurnId: OrchestrationV2ProviderTurn["id"],
  status: "completed" | "failed" | "interrupted",
  at: DateTime.Utc,
) {
  const open = (record: OrchestrationV2ExecutionNode | OrchestrationV2TurnItem) =>
    record.providerTurnId === providerTurnId &&
    (record.status === "running" || record.status === "waiting");
  for (const node of records.nodes.values())
    if (open(node))
      yield* records.emit({
        type: "node.updated",
        driver: records.driver,
        node: { ...node, status, completedAt: at },
      });
  for (const item of records.items.values())
    if (open(item))
      yield* records.emit({
        type: "turn_item.updated",
        driver: records.driver,
        turnItem: {
          ...item,
          status,
          completedAt: at,
          updatedAt: at,
          ...("streaming" in item ? { streaming: false } : {}),
        },
      });
  for (const [id, message] of messages) {
    if (!message.streaming) continue;
    const completed = { ...message, streaming: false, updatedAt: at };
    messages.set(id, completed);
    yield* records.emit({ type: "message.updated", driver: records.driver, message: completed });
  }
});

export const make = Effect.fn("KiloAdapterV2.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly continuationKey: string;
  readonly cwd: string;
  readonly attachmentsDir?: string;
  readonly runtime: KiloRuntime.KiloRuntime["Service"];
}) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const crypto = yield* Crypto.Crypto;
  const itemKey = (nativeId: string) =>
    `${options.instanceId}:${options.continuationKey}:${nativeId}`;
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: KILO_PROVIDER,
    getCapabilities: () => Effect.succeed(kiloCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("KiloAdapterV2.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const turnGate = yield* Semaphore.make(1);
      const directory = input.runtimePolicy.cwd ?? options.cwd;
      const connection = yield* wire(options.runtime.open(directory));
      const client = connection.client;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: KILO_PROVIDER,
        providerInstanceId: options.instanceId,
        cwd: directory,
        model: input.modelSelection.model,
        status: "ready" as const,
        capabilities: kiloCapabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event, Cause.Done>();
      const nodes = new Map<string, OrchestrationV2ExecutionNode>();
      const items = new Map<string, OrchestrationV2TurnItem>();
      const emit = (event: Adapter.ProviderAdapterV2Event) =>
        Effect.suspend(() => {
          if (event.type === "provider_session.updated") session = event.providerSession;
          if (event.type === "node.updated") nodes.set(event.node.id, event.node);
          if (event.type === "turn_item.updated") items.set(event.turnItem.id, event.turnItem);
          return Queue.offer(events, event).pipe(Effect.asVoid);
        });
      const records = { driver: KILO_PROVIDER, emit, nodes, items };
      let ref: KiloSessionRef | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active:
        | {
            input: Adapter.ProviderAdapterV2TurnInput;
            turn: OrchestrationV2ProviderTurn;
            messageID: string;
            admitted: boolean;
            interrupting: boolean;
            reportedError?: boolean;
            finishing?: boolean;
          }
        | undefined;
      const messages = new Map<string, OrchestrationV2ConversationMessage>();
      const parts = new Map<string, Part>();
      const partsByMessage = new Map<string, Map<string, Part>>();
      const timestamps = new Map<string, DateTime.Utc>();
      const putPart = (part: Part) => {
        parts.set(part.id, part);
        const grouped = partsByMessage.get(part.messageID) ?? new Map<string, Part>();
        grouped.set(part.id, part);
        partsByMessage.set(part.messageID, grouped);
      };
      const roles = new Map<string, "user" | "assistant">();
      const parents = new Map<string, string>();
      const completedMessages = new Set<string>();
      const providerTurns = new Map<string, OrchestrationV2ProviderTurn>();
      const childThreads = new Map<string, OrchestrationV2ProviderThread>();
      const subagents = new Map<string, OrchestrationV2Subagent>();
      const requests = new Map<
        RuntimeRequestId,
        { runtime: OrchestrationV2RuntimeRequest; native: PermissionRequest | QuestionRequest }
      >();
      const ordinals = new Map<string, number>();
      const ordinal = (key: string) => {
        let value = ordinals.get(key);
        if (value === undefined) {
          value = ordinals.size + 1;
          ordinals.set(key, value);
        }
        return value;
      };
      const current = () =>
        ref === undefined ? Effect.fail(error("Kilo thread is not loaded")) : Effect.succeed(ref);
      const ownedThread = (candidate: OrchestrationV2ProviderThread) =>
        thread &&
        candidate.id === thread.id &&
        candidate.appThreadId === thread.appThreadId &&
        candidate.driver === KILO_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.nativeThreadRef?.nativeId === ref?.sessionId &&
        candidate.nativeMetadata?.continuationKey === options.continuationKey
          ? current()
          : Effect.fail(error("Kilo thread does not belong to this account and session"));
      const resolveMessage = (id: string) => thread?.nativeMetadata?.messageAliases?.[id] ?? id;
      let correlationMetadata: OrchestrationV2ProviderThread["nativeMetadata"];
      const correlatedMessages = new Map<
        string,
        NonNullable<
          NonNullable<OrchestrationV2ProviderThread["nativeMetadata"]>["turnCorrelations"]
        >[string]
      >();
      const correlationFor = (id: string) => {
        if (correlationMetadata !== thread?.nativeMetadata) {
          correlationMetadata = thread?.nativeMetadata;
          correlatedMessages.clear();
          for (const [nativeId, value] of Object.entries(
            correlationMetadata?.turnCorrelations ?? {},
          ))
            correlatedMessages.set(resolveMessage(nativeId), value);
        }
        return correlatedMessages.get(id);
      };
      const finish = Effect.fn("KiloAdapterV2.finish")(function* (
        status: "completed" | "interrupted" | "failed",
        detail?: string,
      ) {
        const running = active;
        if (!running || running.finishing) return;
        running.finishing = true;
        const completedAt = yield* DateTime.now;
        providerTurns.set(running.turn.id, { ...running.turn, status, completedAt });
        const correlation = thread?.nativeMetadata?.turnCorrelations?.[running.messageID];
        if (thread && correlation) {
          thread = {
            ...thread,
            nativeMetadata: {
              ...thread.nativeMetadata,
              turnCorrelations: {
                ...thread.nativeMetadata?.turnCorrelations,
                [running.messageID]: {
                  ...correlation,
                  terminalStatus: status,
                  completedAt: DateTime.formatIso(completedAt),
                },
              },
            },
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: KILO_PROVIDER,
            providerThread: thread,
          });
        }
        for (const pending of requests.values()) {
          if (pending.runtime.status !== "pending") continue;
          pending.runtime = { ...pending.runtime, status: "cancelled", resolvedAt: completedAt };
          yield* emit({
            type: "runtime_request.updated",
            driver: KILO_PROVIDER,
            runtimeRequest: pending.runtime,
          });
        }
        yield* kiloEndOpenRecords(records, messages, running.turn.id, status, completedAt);
        for (const [id, child] of subagents) {
          if (child.runId !== running.input.runId || child.status !== "running") continue;
          const ended = { ...child, status, completedAt, updatedAt: completedAt };
          subagents.set(id, ended);
          yield* emit({ type: "subagent.updated", driver: KILO_PROVIDER, subagent: ended });
        }
        for (const [id, child] of childThreads) {
          if (child.status !== "active") continue;
          const ended = { ...child, status: "idle" as const, updatedAt: completedAt };
          childThreads.set(id, ended);
          yield* emit({
            type: "provider_thread.updated",
            driver: KILO_PROVIDER,
            providerThread: ended,
          });
        }
        active = undefined;
        if (session.status !== "ready" && status !== "interrupted" && (yield* connection.isRunning))
          yield* emit({
            type: "provider_session.updated",
            driver: KILO_PROVIDER,
            providerSession: {
              ...session,
              status: "ready",
              lastError: null,
              updatedAt: completedAt,
            },
          });
        yield* emit({
          type: "provider_turn.updated",
          driver: KILO_PROVIDER,
          providerTurn: { ...running.turn, status, completedAt },
        });
        if (status === "failed")
          yield* emit({
            type: "turn.terminal",
            driver: KILO_PROVIDER,
            providerThreadId: running.turn.providerThreadId,
            providerTurnId: running.turn.id,
            runOrdinal: running.input.runOrdinal,
            failureItemOrdinal: ordinals.size + 1,
            status,
            failure: makeProviderFailure({
              message: detail ?? "Kilo failed",
              class: "provider_error",
            }),
            threadDisposition: "broken",
          });
        else
          yield* emit({
            type: "turn.terminal",
            driver: KILO_PROVIDER,
            providerThreadId: running.turn.providerThreadId,
            providerTurnId: running.turn.id,
            runOrdinal: running.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: status === "interrupted" ? "broken" : "reusable",
          });
      });
      yield* connection.exitCode.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            // The Stop owner waits for runtime cleanup before publishing terminality.
            // Linux verifies observed group members; this is not descendant containment.
            if (!active || active.interrupting) return;
            yield* connection.cleanup;
            yield* finish("failed", "Kilo process exited.");
          }),
        ),
        Effect.forkIn(scope),
      );
      const messageFromParts = Effect.fn("KiloAdapterV2.message")(function* (
        messageID: string,
        completed = false,
        publish = true,
      ) {
        if (!thread?.appThreadId || !roles.has(messageID)) return;
        const role = roles.get(messageID)!;
        const updatedAt = yield* DateTime.now;
        const owningTurn =
          messageID === active?.messageID || parents.get(messageID) === active?.messageID
            ? active
            : undefined;
        const correlationId = role === "user" ? messageID : (parents.get(messageID) ?? "");
        const correlation = correlationFor(correlationId);
        const text = [...(partsByMessage.get(messageID)?.values() ?? [])]
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        const previous = messages.get(messageID);
        const message: OrchestrationV2ConversationMessage = {
          id:
            (role === "user" ? correlation?.messageId : undefined) ??
            ids.derive.messageFromProviderItem({
              driver: KILO_PROVIDER,
              nativeItemId: itemKey(messageID),
            }),
          threadId: thread.appThreadId,
          runId: owningTurn?.input.runId ?? previous?.runId ?? correlation?.runId ?? null,
          nodeId: owningTurn?.input.rootNodeId ?? previous?.nodeId ?? correlation?.nodeId ?? null,
          role,
          text,
          attachments: role === "user" ? (correlation?.attachments ?? []) : [],
          streaming: role === "assistant" && !completed && !completedMessages.has(messageID),
          createdAt: previous?.createdAt ?? timestamps.get(messageID) ?? updatedAt,
          updatedAt,
          createdBy: role === "user" ? (correlation?.createdBy ?? "user") : "agent",
          creationSource:
            role === "user" ? (correlation?.creationSource ?? "provider") : "provider",
          ...(role === "user"
            ? {
                scheduledTaskId: correlation?.scheduledTaskId,
                senderThreadId: correlation?.senderThreadId,
              }
            : {}),
        };
        messages.set(messageID, message);
        // T3 owns submitted user messages, including context and provenance absent from native history.
        // Echoing native file/text parts must not overwrite that durable row.
        if (publish && !(role === "user" && correlation))
          yield* emit({ type: "message.updated", driver: KILO_PROVIDER, message });
      });
      const textPart = Effect.fn("KiloAdapterV2.textPart")(function* (
        part: Extract<Part, { type: "text" | "reasoning" }>,
      ) {
        const running = active;
        if (!running || !thread || parents.get(part.messageID) !== running.messageID) return;
        const at = yield* DateTime.now;
        const done = part.time?.end !== undefined || completedMessages.has(part.messageID);
        const key = itemKey(part.id);
        const nodeId = ids.derive.nodeFromProviderItem({
          driver: KILO_PROVIDER,
          nativeItemId: key,
        });
        const base = {
          id: ids.derive.turnItemFromProviderItem({ driver: KILO_PROVIDER, nativeItemId: key }),
          threadId: running.input.threadId,
          runId: running.input.runId,
          nodeId,
          providerThreadId: thread.id,
          providerTurnId: running.turn.id,
          nativeItemRef: nativeRef(part.id),
          parentItemId: null,
          ordinal: ordinal(part.id),
          status: done ? ("completed" as const) : ("running" as const),
          title: null,
          startedAt: running.turn.startedAt,
          completedAt: done ? at : null,
          updatedAt: at,
        };
        yield* emit({
          type: "node.updated",
          driver: KILO_PROVIDER,
          node: kiloPartNode(
            base,
            running.input.rootNodeId,
            part.type === "text" ? "assistant_message" : "reasoning",
          ),
        });
        yield* emit({
          type: "turn_item.updated",
          driver: KILO_PROVIDER,
          turnItem:
            part.type === "reasoning"
              ? { ...base, type: "reasoning", text: part.text, streaming: !done }
              : {
                  ...base,
                  type: "assistant_message",
                  messageId: ids.derive.messageFromProviderItem({
                    driver: KILO_PROVIDER,
                    nativeItemId: itemKey(part.messageID),
                  }),
                  text: part.text,
                  streaming: !done,
                },
        });
      });
      const task = Effect.fn("KiloAdapterV2.task")(function* (
        part: Extract<Part, { type: "tool" }>,
      ) {
        const running = active;
        if (!running || !thread) return;
        const at = yield* DateTime.now;
        const key = itemKey(part.id);
        const nodeId = ids.derive.nodeFromProviderItem({
          driver: KILO_PROVIDER,
          nativeItemId: key,
        });
        const metadata =
          part.state.status === "running" || part.state.status === "completed"
            ? part.state.metadata
            : undefined;
        const childId = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined;
        const prompt = typeof part.state.input.prompt === "string" ? part.state.input.prompt : "";
        const title =
          typeof part.state.input.description === "string"
            ? part.state.input.description
            : "Kilo subagent";
        const previous = subagents.get(part.id);
        let child = childId
          ? childThreads.get(childId)
          : [...childThreads.values()].find(
              (candidate) => candidate.id === previous?.providerThreadId,
            );
        if (childId && !child) {
          const native = { instanceId: options.continuationKey, directory, sessionId: childId };
          const nativeChild = yield* wire(client.read(native));
          if (nativeChild.parentID !== ref?.sessionId)
            return yield* error("Kilo task is not owned by this conversation");
          const childThreadId = ids.derive.threadFromProviderThread({
            driver: KILO_PROVIDER,
            nativeThreadId: itemKey(childId),
          });
          child = {
            ...thread,
            id: ids.derive.providerThread({
              driver: KILO_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: itemKey(childId),
            }),
            appThreadId: childThreadId,
            ownerNodeId: nodeId,
            nativeThreadRef: nativeRef(childId),
            status: "active",
            nativeMetadata: { continuationKey: options.continuationKey, itemIdentityVersion: 2 },
          };
          childThreads.set(childId, child);
          yield* emit({
            type: "app_thread.created",
            driver: KILO_PROVIDER,
            appThread: makeSubagentChildThread({
              parentThread: running.input.appThread,
              childThreadId,
              parentNodeId: nodeId,
              activeProviderThreadId: child.id,
              providerInstanceId: options.instanceId,
              modelSelection: running.input.modelSelection,
              title,
              now: at,
              createdBy: "agent",
              creationSource: "provider",
            }),
          });
          yield* emit({
            type: "provider_thread.updated",
            driver: KILO_PROVIDER,
            providerThread: child,
          });
        }
        const status =
          part.state.status === "completed"
            ? "completed"
            : part.state.status === "error"
              ? "failed"
              : "running";
        const completedAt = status === "running" ? null : at;
        const subagent: OrchestrationV2Subagent = {
          id: nodeId,
          threadId: running.input.threadId,
          runId: running.input.runId,
          parentNodeId: running.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: KILO_PROVIDER,
          providerInstanceId: options.instanceId,
          providerThreadId: child?.id ?? previous?.providerThreadId ?? null,
          childThreadId: child?.appThreadId ?? previous?.childThreadId ?? null,
          nativeTaskRef: nativeRef(part.id),
          prompt,
          title,
          model: null,
          status,
          result: part.state.status === "completed" ? part.state.output : null,
          startedAt: previous?.startedAt ?? at,
          completedAt,
          updatedAt: at,
        };
        subagents.set(part.id, subagent);
        yield* emit({ type: "subagent.updated", driver: KILO_PROVIDER, subagent });
        yield* emit({
          type: "node.updated",
          driver: KILO_PROVIDER,
          node: {
            id: nodeId,
            threadId: running.input.threadId,
            runId: running.input.runId,
            parentNodeId: running.input.rootNodeId,
            rootNodeId: running.input.rootNodeId,
            kind: "subagent",
            status,
            countsForRun: false,
            providerThreadId: child?.id ?? thread.id,
            providerTurnId: running.turn.id,
            nativeItemRef: nativeRef(part.id),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: subagent.startedAt,
            completedAt,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: KILO_PROVIDER,
          turnItem: {
            id: ids.derive.turnItemFromProviderItem({ driver: KILO_PROVIDER, nativeItemId: key }),
            threadId: running.input.threadId,
            runId: running.input.runId,
            nodeId,
            providerThreadId: thread.id,
            providerTurnId: running.turn.id,
            nativeItemRef: nativeRef(part.id),
            parentItemId: null,
            ordinal: ordinal(part.id),
            status,
            title,
            startedAt: subagent.startedAt,
            completedAt,
            updatedAt: at,
            type: "subagent",
            subagentId: nodeId,
            origin: "provider_native",
            driver: KILO_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId: subagent.childThreadId,
            prompt,
            result: subagent.result,
          },
        });
        const completedChildId = child?.nativeThreadRef?.nativeId;
        if (completedChildId && child?.appThreadId && completedAt) {
          const history = yield* wire(
            client.history({
              instanceId: options.continuationKey,
              directory,
              sessionId: completedChildId,
            }),
          );
          for (const [index, entry] of history.entries()) {
            const text = entry.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n");
            const artifacts = makeSubagentConversationArtifacts({
              messageId: ids.derive.messageFromProviderItem({
                driver: KILO_PROVIDER,
                nativeItemId: itemKey(entry.info.id),
              }),
              turnItemId: ids.derive.turnItemFromProviderItem({
                driver: KILO_PROVIDER,
                nativeItemId: itemKey(entry.info.id),
              }),
              threadId: child.appThreadId,
              rootNodeId: nodeId,
              providerThreadId: child.id,
              providerTurnId: null,
              nativeItemRef: nativeRef(entry.info.id),
              role: entry.info.role,
              text,
              ordinal: index + 1,
              now: DateTime.makeUnsafe(entry.info.time.created),
            });
            yield* emit({
              type: "message.updated",
              driver: KILO_PROVIDER,
              message: artifacts.message,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: KILO_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }
          const endedChild = { ...child, status: "idle" as const, updatedAt: at };
          childThreads.set(completedChildId, endedChild);
          yield* emit({
            type: "provider_thread.updated",
            driver: KILO_PROVIDER,
            providerThread: endedChild,
          });
        }
      });
      const tool = Effect.fn("KiloAdapterV2.tool")(function* (
        part: Extract<Part, { type: "tool" }>,
      ) {
        if (part.tool === "task") return yield* task(part);
        if (part.tool === "question") return;
        const running = active;
        if (!running || !thread || parents.get(part.messageID) !== running.messageID) return;
        const at = yield* DateTime.now;
        const key = itemKey(part.id);
        const nodeId = ids.derive.nodeFromProviderItem({
          driver: KILO_PROVIDER,
          nativeItemId: key,
        });
        const done = part.state.status === "completed" || part.state.status === "error";
        const status = part.state.status === "error" ? "failed" : part.state.status;
        const base = {
          id: ids.derive.turnItemFromProviderItem({ driver: KILO_PROVIDER, nativeItemId: key }),
          threadId: running.input.threadId,
          runId: running.input.runId,
          nodeId,
          providerThreadId: thread.id,
          providerTurnId: running.turn.id,
          nativeItemRef: nativeRef(part.id),
          parentItemId: null,
          ordinal: ordinal(part.id),
          status: status as OrchestrationV2TurnItem["status"],
          title: part.tool,
          startedAt: running.turn.startedAt,
          completedAt: done ? at : null,
          updatedAt: at,
        };
        yield* emit({
          type: "node.updated",
          driver: KILO_PROVIDER,
          node: kiloPartNode(base, running.input.rootNodeId, "tool_call"),
        });
        yield* emit({
          type: "turn_item.updated",
          driver: KILO_PROVIDER,
          turnItem: openCodeToolTurnItem(base, {
            name: part.tool,
            input: part.state.input,
            output:
              part.state.status === "completed"
                ? part.state.output
                : part.state.status === "error"
                  ? part.state.error
                  : undefined,
            completedMetadata: part.state.status === "completed" ? part.state.metadata : undefined,
          }),
        });
      });
      const ask = Effect.fn("KiloAdapterV2.ask")(function* (
        native: PermissionRequest | QuestionRequest,
      ) {
        const running = active;
        const requestId = RuntimeRequestId.make(itemKey(native.id));
        if (!running || !thread || requests.has(requestId)) return;
        const interaction = kiloInteraction({
          native,
          requestId,
          nodeId: ids.derive.approvalNode({ requestId }),
          turnItemId: ids.derive.approvalTurnItem({ requestId }),
          nativeRef: nativeRef(native.id),
          threadId: running.input.threadId,
          runId: running.input.runId,
          rootNodeId: running.input.rootNodeId,
          providerThreadId: thread.id,
          providerTurnId: running.turn.id,
          providerSessionId: input.providerSessionId,
          ordinal: ordinal(native.id),
          at: yield* DateTime.now,
        });
        requests.set(requestId, { runtime: interaction.runtime, native });
        yield* emit({ type: "node.updated", driver: KILO_PROVIDER, node: interaction.node });
        yield* emit({
          type: "runtime_request.updated",
          driver: KILO_PROVIDER,
          threadId: running.input.threadId,
          runtimeRequest: interaction.runtime,
        });
        yield* emit({
          type: "turn_item.updated",
          driver: KILO_PROVIDER,
          turnItem: interaction.turnItem,
        });
      });
      const handle = Effect.fn("KiloAdapterV2.event")(function* (event: Event) {
        const eventSession =
          event.type === "message.updated"
            ? event.properties.info.sessionID
            : event.type === "message.part.updated"
              ? event.properties.part.sessionID
              : "sessionID" in event.properties
                ? event.properties.sessionID
                : undefined;
        // Child approvals are answered against the asking native session. Child completion is
        // projected from the owning task, so it cannot accidentally complete the parent's turn.
        if (
          eventSession &&
          eventSession !== ref?.sessionId &&
          event.type !== "permission.asked" &&
          event.type !== "question.asked"
        )
          return;
        switch (event.type) {
          case "message.updated":
            roles.set(event.properties.info.id, event.properties.info.role);
            timestamps.set(
              event.properties.info.id,
              DateTime.makeUnsafe(event.properties.info.time.created),
            );
            if (event.properties.info.role === "assistant") {
              parents.set(event.properties.info.id, event.properties.info.parentID);
              if (event.properties.info.time.completed !== undefined)
                completedMessages.add(event.properties.info.id);
            }
            if (active?.messageID === event.properties.info.id) active.admitted = true;
            if (event.properties.info.role === "assistant")
              yield* messageFromParts(
                event.properties.info.id,
                event.properties.info.time.completed !== undefined,
              );
            return;
          case "message.part.updated":
            putPart(event.properties.part);
            if (event.properties.part.type === "tool") yield* tool(event.properties.part);
            else {
              if (
                event.properties.part.type === "text" ||
                event.properties.part.type === "reasoning"
              )
                yield* textPart(event.properties.part);
              yield* messageFromParts(event.properties.part.messageID);
            }
            return;
          case "message.part.delta": {
            const part = parts.get(event.properties.partID);
            if (
              part &&
              (part.type === "text" || part.type === "reasoning") &&
              event.properties.field === "text"
            ) {
              const updated = { ...part, text: part.text + event.properties.delta };
              putPart(updated);
              yield* textPart(updated);
              yield* messageFromParts(part.messageID);
            }
            return;
          }
          case "permission.asked":
          case "question.asked":
            yield* ask(event.properties);
            return;
          case "session.idle":
            if (active?.admitted) yield* reconcile();
            return;
          case "session.error":
            // Context overflow also emits this event while native compaction continues.
            // Only idle + persisted assistant state or process exit proves terminality.
            if (active) {
              active.reportedError = true;
              yield* reconcile();
            }
            return;
        }
      });
      const hydrate = Effect.fn("KiloAdapterV2.hydrate")(function* () {
        const currentRef = yield* current();
        const nativeSession = yield* wire(client.read(currentRef));
        const all = yield* wire(client.history(currentRef));
        const revertedAt = nativeSession.revert?.messageID;
        const boundary = revertedAt ? all.findIndex((entry) => entry.info.id === revertedAt) : -1;
        const history = boundary < 0 ? all : all.slice(0, boundary);
        const previousMessages = new Map(messages);
        messages.clear();
        parts.clear();
        partsByMessage.clear();
        roles.clear();
        parents.clear();
        completedMessages.clear();
        for (const entry of history) {
          if (entry.info.role === "assistant") {
            parents.set(entry.info.id, entry.info.parentID);
            if (entry.info.time.completed) completedMessages.add(entry.info.id);
          }
          timestamps.set(entry.info.id, DateTime.makeUnsafe(entry.info.time.created));
          const previous = previousMessages.get(entry.info.id);
          if (previous) messages.set(entry.info.id, previous);
          roles.set(entry.info.id, entry.info.role);
          if (entry.info.id === active?.messageID) active.admitted = true;
          for (const part of entry.parts) {
            putPart(part);
            if (
              part.type === "tool" &&
              part.tool === "task" &&
              parents.get(part.messageID) === active?.messageID
            )
              yield* task(part);
          }
          // Snapshot reads must not re-publish historical records over T3's durable run metadata.
          yield* messageFromParts(
            entry.info.id,
            true,
            active !== undefined &&
              (entry.info.id === active.messageID ||
                parents.get(entry.info.id) === active.messageID),
          );
        }
        const users = history.filter((entry) => entry.info.role === "user");
        const correlations = new Map(
          Object.entries(thread?.nativeMetadata?.turnCorrelations ?? {}).map(([id, value]) => [
            resolveMessage(id),
            { id, value },
          ]),
        );
        for (const [index, entry] of users.entries()) {
          const correlation = correlations.get(entry.info.id);
          const nativeId = correlation?.id ?? entry.info.id;
          const id = ids.derive.providerTurn({
            driver: KILO_PROVIDER,
            nativeTurnId: itemKey(nativeId),
          });
          if (providerTurns.has(id) || !thread) continue;
          const replies = history.filter(
            (m) => m.info.role === "assistant" && m.info.parentID === entry.info.id,
          );
          const last = replies.at(-1)?.info;
          const failed = last?.role === "assistant" ? last.error : undefined;
          const ended = last?.role === "assistant" ? last.time.completed : undefined;
          providerTurns.set(id, {
            id,
            providerThreadId: thread.id,
            nodeId:
              correlation?.value.nodeId ??
              ids.derive.nodeFromProviderItem({
                driver: KILO_PROVIDER,
                nativeItemId: itemKey(nativeId),
              }),
            runAttemptId: correlation?.value.attemptId ?? null,
            nativeTurnRef: nativeRef(entry.info.id),
            ordinal: correlation?.value.ordinal ?? index + 1,
            status:
              correlation?.value.terminalStatus ??
              (failed
                ? failed.name === "MessageAbortedError"
                  ? "interrupted"
                  : "failed"
                : ended
                  ? "completed"
                  : "interrupted"),
            startedAt: DateTime.makeUnsafe(entry.info.time.created),
            completedAt: correlation?.value.completedAt
              ? DateTime.makeUnsafe(correlation.value.completedAt)
              : ended
                ? DateTime.makeUnsafe(ended)
                : null,
          });
        }
        return history;
      });
      const reconcile = Effect.fn("KiloAdapterV2.reconcile")(function* () {
        const native = yield* current();
        const history = yield* hydrate();
        if (!active) return;
        const pending = yield* wire(client.pending(native, true));
        const present = new Set(pending.map((request) => request.id));
        for (const request of pending) yield* ask(request);
        for (const saved of requests.values()) {
          if (saved.runtime.status !== "pending" || present.has(saved.native.id)) continue;
          saved.runtime = yield* kiloSettleRequest(
            records,
            saved.runtime,
            ids.derive.approvalTurnItem({ requestId: saved.runtime.id }),
            "cancelled",
          );
        }
        if (!active?.admitted) return;
        const status = yield* wire(client.status(native));
        if (status !== "idle") return;
        const replies = history.filter(
          (m) => m.info.role === "assistant" && m.info.parentID === active?.messageID,
        );
        const last = replies.at(-1)?.info;
        if (active.interrupting) return;
        // A successful reply after compaction supersedes the earlier recoverable error.
        if (last?.role === "assistant" && last.time.completed !== undefined && !last.error)
          yield* finish("completed");
        else if ((last?.role === "assistant" && last.error) || active.reportedError)
          yield* finish("failed", "Kilo recorded an error while processing this turn.");
      });
      let subscribed = false;
      let eventFiber: Fiber.Fiber<void> | undefined;
      const startEvents = Effect.fn("KiloAdapterV2.subscribe")(function* () {
        if (subscribed) return;
        const ready = yield* Deferred.make<void, Adapter.ProviderAdapterProtocolError>();
        const native = yield* current();
        const watch = Effect.gen(function* () {
          while (yield* connection.isRunning) {
            yield* client
              .events(
                native,
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      active
                        ? reconcile().pipe(
                            Effect.catchDefect(() =>
                              Effect.fail(error("Kilo returned invalid recovery data")),
                            ),
                            Effect.mapError(
                              (cause) =>
                                new KiloSessionError({
                                  operation: "reconnect",
                                  reason: "request_failed",
                                  cause,
                                }),
                            ),
                          )
                        : Effect.void,
                    ),
                  ),
                  Effect.andThen(
                    Effect.gen(function* () {
                      if (
                        session.status === "ready" ||
                        (session.status === "waiting" && active && !active.admitted) ||
                        !(yield* connection.isRunning)
                      )
                        return;
                      yield* emit({
                        type: "provider_session.updated",
                        driver: KILO_PROVIDER,
                        providerSession: {
                          ...session,
                          status: "ready",
                          lastError: null,
                          updatedAt: yield* DateTime.now,
                        },
                      });
                    }),
                  ),
                ),
                true,
              )
              .pipe(
                Stream.runForEach((event) =>
                  handle(event).pipe(
                    Effect.catchDefect(() =>
                      Effect.fail(error("Kilo emitted an invalid event payload")),
                    ),
                  ),
                ),
                Effect.catch(() =>
                  Effect.gen(function* () {
                    yield* Deferred.fail(ready, error("Kilo stream did not become ready"));
                    if (!(yield* connection.isRunning)) {
                      if (active && !active.interrupting) {
                        yield* connection.cleanup;
                        yield* finish("failed", "Kilo process exited.");
                      }
                      return;
                    }
                    yield* reconcile().pipe(
                      Effect.catchDefect(() => Effect.void),
                      Effect.ignore,
                    );
                    yield* emit({
                      type: "provider_session.updated",
                      driver: KILO_PROVIDER,
                      providerSession: {
                        ...session,
                        status: "error",
                        lastError:
                          "Kilo stream disconnected; reconnecting. The task may still be running.",
                        updatedAt: yield* DateTime.now,
                      },
                    });
                    yield* Effect.sleep("1 second");
                  }),
                ),
              );
          }
        });
        eventFiber = yield* watch.pipe(Effect.forkIn(scope));
        yield* Deferred.await(ready).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(error("Kilo stream readiness timed out")),
          ),
          Effect.onError(() =>
            Effect.gen(function* () {
              if (eventFiber) yield* Fiber.interrupt(eventFiber);
              eventFiber = undefined;
              subscribed = false;
            }),
          ),
        );
        subscribed = true;
      });
      const bind = Effect.fn("KiloAdapterV2.bind")(function* (
        native: KiloSessionRef,
        appThreadId: OrchestrationV2ProviderThread["appThreadId"],
        existing?: OrchestrationV2ProviderThread,
      ) {
        if (ref && ref.sessionId !== native.sessionId && subscribed)
          return yield* error("This Kilo session already owns another native thread");
        ref = native;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              status: "idle",
              nativeThreadRef: nativeRef(native.sessionId),
              nativeMetadata: existing.nativeThreadRef
                ? existing.nativeMetadata
                : { continuationKey: options.continuationKey, itemIdentityVersion: 2 },
            }
          : {
              id: ids.derive.providerThread({
                driver: KILO_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: itemKey(native.sessionId),
              }),
              driver: KILO_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(native.sessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              nativeMetadata: { continuationKey: options.continuationKey, itemIdentityVersion: 2 },
              createdAt: now,
              updatedAt: now,
            };
        yield* startEvents();
        return thread;
      });
      const snapshot = Effect.fn("KiloAdapterV2.snapshot")(function* () {
        yield* hydrate();
        if (!thread) return yield* error("Kilo thread is not loaded");
        return {
          providerThread: thread,
          providerTurns: [...providerTurns.values()],
          messages: [...messages.values()],
          runtimeRequests: [...requests.values()].map((r) => r.runtime),
        };
      });
      const resumeThread = (
        request: Parameters<Adapter.ProviderAdapterV2SessionRuntime["resumeThread"]>[0],
      ) =>
        Effect.gen(function* () {
          if (active) return yield* error("Stop the Kilo task before restoring a conversation");
          const saved = request.providerThread;
          if (
            saved.providerInstanceId !== options.instanceId ||
            saved.nativeMetadata?.continuationKey !== options.continuationKey ||
            !saved.nativeThreadRef?.nativeId
          )
            return yield* error(
              "Kilo account or configuration changed; the previous native session cannot be resumed",
            );
          const native = {
            instanceId: options.continuationKey,
            directory,
            sessionId: saved.nativeThreadRef.nativeId,
          };
          // Runtime's client uses the same account-scoped instance identity.
          yield* wire(client.read(native));
          yield* wire(
            client.setPermissions(
              native,
              permissions(request.runtimePolicy ?? input.runtimePolicy),
            ),
          );
          return yield* bind(native, saved.appThreadId, saved);
        });
      // Native revert changes files, so rewind and fork copy only the conversation before
      // `next`; T3 owns filesystem rewind. Aliases map original message IDs to the copies.
      const forkBefore = Effect.fn("KiloAdapterV2.forkBefore")(function* (
        native: KiloSessionRef,
        history: Effect.Success<ReturnType<typeof client.history>>,
        next: string | undefined,
      ) {
        const fork = yield* wire(client.fork(native, next));
        const retained = next
          ? history.slice(
              0,
              history.findIndex((m) => m.info.id === next),
            )
          : history;
        const copied = yield* wire(client.history(fork));
        if (
          copied.length !== retained.length ||
          copied.some((m, i) => m.info.role !== retained[i]?.info.role)
        )
          return yield* error("Kilo fork returned an unexpected conversation boundary");
        const aliases = { ...thread?.nativeMetadata?.messageAliases };
        for (const [i, entry] of retained.entries()) {
          const replacement = copied[i]!.info.id;
          for (const [old, currentId] of Object.entries(aliases))
            if (currentId === entry.info.id) aliases[old] = replacement;
          aliases[entry.info.id] = replacement;
        }
        return { fork, aliases };
      });
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: KILO_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromEffectRepeat(Queue.take(events)),
        ensureThread: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const prior = request.existingProviderThread;
              if (
                prior?.nativeMetadata?.continuationKey &&
                prior.nativeMetadata.continuationKey !== options.continuationKey
              )
                return yield* error("Kilo account changed; start a new thread for this account");
              if (prior?.nativeThreadRef) return yield* resumeThread({ providerThread: prior });
              if (active)
                return yield* error("Stop the Kilo task before replacing its conversation");
              const native = yield* wire(client.create(permissions(request.runtimePolicy)));
              return yield* bind(native, request.threadId, prior);
            }),
          ),
        resumeThread: (request) => turnGate.withPermit(resumeThread(request)),
        startTurn: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const native = yield* ownedThread(request.providerThread);
              if (
                request.threadId !== thread?.appThreadId ||
                request.appThread.id !== request.threadId ||
                (request.runtimePolicy.cwd ?? options.cwd) !== directory
              )
                return yield* error("Kilo turn does not belong to this workspace and thread");
              if (!(yield* connection.isRunning))
                return yield* error(
                  "Kilo process stopped; resume the session before starting a turn",
                );
              if (active)
                return yield* error("A Kilo task is still running or its admission is unresolved");
              if (request.message.attachments.length && !options.attachmentsDir)
                return yield* error("Kilo attachment storage is unavailable");
              const files = toOpenCodeFileParts({
                attachments: request.message.attachments,
                resolveAttachmentPath: (attachment) =>
                  options.attachmentsDir
                    ? resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment })
                    : null,
              });
              yield* wire(client.setPermissions(native, permissions(request.runtimePolicy)));
              const slash = request.modelSelection.model.indexOf("/");
              if (slash <= 0) return yield* error("Kilo models must use provider/model format");
              const startedAt = yield* DateTime.now;
              const uuid = yield* crypto.randomUUIDv4.pipe(
                Effect.mapError(() => error("Could not allocate a Kilo message identity")),
              );
              const messageID = `msg_${(BigInt(DateTime.toEpochMillis(startedAt)) * 4096n).toString(16)}${uuid.replaceAll("-", "")}`;
              const turn: OrchestrationV2ProviderTurn = {
                id: ids.derive.providerTurn({
                  driver: KILO_PROVIDER,
                  nativeTurnId: itemKey(messageID),
                }),
                providerThreadId: request.providerThread.id,
                nodeId: request.rootNodeId,
                runAttemptId: request.attemptId,
                nativeTurnRef: nativeRef(messageID),
                ordinal: request.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              };
              active = { input: request, turn, messageID, admitted: false, interrupting: false };
              thread = {
                ...request.providerThread,
                nativeMetadata: {
                  ...thread?.nativeMetadata,
                  turnCorrelations: {
                    ...thread?.nativeMetadata?.turnCorrelations,
                    [messageID]: {
                      messageId: request.message.messageId,
                      nodeId: request.rootNodeId,
                      runId: request.runId,
                      attemptId: request.attemptId,
                      ordinal: request.providerTurnOrdinal,
                      attachments: request.message.attachments,
                      createdBy: request.message.createdBy,
                      creationSource: request.message.creationSource,
                      scheduledTaskId: request.message.scheduledTaskId,
                      senderThreadId: request.message.senderThreadId,
                    },
                  },
                },
              };
              yield* emit({
                type: "provider_thread.updated",
                driver: KILO_PROVIDER,
                providerThread: thread,
              });
              ordinals.clear();
              nodes.clear();
              items.clear();
              parts.clear();
              partsByMessage.clear();
              parents.clear();
              roles.clear();
              providerTurns.set(turn.id, turn);
              yield* emit({
                type: "provider_turn.updated",
                driver: KILO_PROVIDER,
                providerTurn: turn,
              });
              yield* client
                .prompt(native, {
                  messageID,
                  model: {
                    providerID: request.modelSelection.model.slice(0, slash),
                    modelID: request.modelSelection.model.slice(slash + 1),
                  },
                  agent:
                    request.runtimePolicy.interactionMode === "plan"
                      ? "plan"
                      : (getModelSelectionStringOptionValue(request.modelSelection, "agent") ??
                        "build"),
                  ...(getModelSelectionStringOptionValue(request.modelSelection, "variant")
                    ? {
                        variant: getModelSelectionStringOptionValue(
                          request.modelSelection,
                          "variant",
                        )!,
                      }
                    : {}),
                  parts: [{ type: "text", text: request.message.text }, ...files],
                })
                .pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (active?.turn.id !== turn.id) return;
                      active.admitted = true;
                      if (active.reportedError) yield* reconcile().pipe(Effect.ignore);
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      // A timeout after admission must not fail startTurn: T3 would detach its event consumer.
                      if (cause.reason !== "admission_unknown") {
                        yield* finish("failed", "Kilo rejected the prompt.");
                        return;
                      }
                      yield* reconcile().pipe(
                        Effect.catchDefect(() => Effect.void),
                        Effect.ignore,
                      );
                      if (!active) return;
                      yield* emit({
                        type: "provider_session.updated",
                        driver: KILO_PROVIDER,
                        providerSession: {
                          ...session,
                          status: "waiting",
                          lastError:
                            cause.reason === "admission_unknown"
                              ? "Prompt acceptance is uncertain. Kilo is still being monitored; do not resubmit. Stop the session to cancel safely."
                              : "Kilo did not confirm prompt acceptance. Stop this session before retrying.",
                          updatedAt: yield* DateTime.now,
                        },
                      });
                    }),
                  ),
                );
            }),
          ),
        steerTurn: (request) =>
          Effect.fail(
            new Adapter.ProviderAdapterSteerRunUnsupportedError({
              driver: KILO_PROVIDER,
              providerThreadId: request.providerThread.id,
            }),
          ),
        interruptTurn: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const native = yield* ownedThread(request.providerThread);
              // A delayed Stop for the previous turn must not terminate its successor.
              if (!active || active.turn.id !== request.providerTurnId) return;
              active.interrupting = true;
              yield* client.abort(native).pipe(Effect.ignore);
              // Killing this session's owned process also covers uncertain admission and descendant tools.
              yield* connection.stop;
              yield* finish("interrupted");
            }),
          ),
        respondToRuntimeRequest: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const pending = requests.get(request.requestId);
              if (!pending || pending.runtime.status !== "pending")
                return yield* error("Kilo request is no longer pending");
              const root = yield* current();
              const native = { ...root, sessionId: pending.native.sessionID };
              // Requests enter this map only after the stream verifies the full parent chain.
              // The client rechecks both the session owner and pending request before replying.
              if ("questions" in pending.native) {
                if (!request.answers) return yield* error("Kilo question requires answers");
                const answers = kiloQuestionAnswers(pending.native.questions, request.answers);
                if (!answers) return yield* error("Each Kilo question requires a text answer");
                yield* wire(client.replyQuestion(native, pending.native.id, answers));
              } else {
                if (!request.decision) return yield* error("Kilo approval requires a decision");
                yield* wire(
                  client.replyPermission(
                    native,
                    pending.native.id,
                    kiloPermissionReply(request.decision),
                  ),
                );
              }
              pending.runtime = yield* kiloSettleRequest(
                records,
                pending.runtime,
                ids.derive.approvalTurnItem({ requestId: request.requestId }),
                "resolved",
              );
            }),
          ),
        readThreadSnapshot: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              yield* ownedThread(request.providerThread);
              if (active) return yield* error("Stop the Kilo task before reading its history");
              return yield* snapshot();
            }),
          ),
        rollbackThread: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const native = yield* ownedThread(request.providerThread);
              if (active) return yield* error("Stop the Kilo task before rewinding");
              const history = yield* wire(client.history(native));
              const target =
                request.target.type === "provider_turn" ? request.target.providerTurn : undefined;
              const targetId = target?.nativeTurnRef?.nativeId;
              if (
                target &&
                (!targetId || !history.some((m) => m.info.id === resolveMessage(targetId)))
              )
                return yield* error("Kilo rewind boundary is unavailable");
              const targetIndex = targetId
                ? history.findIndex((m) => m.info.id === resolveMessage(targetId))
                : -1;
              const next = history.slice(targetIndex + 1).find((m) => m.info.role === "user")
                ?.info.id;
              if (!next) return yield* snapshot();
              const { fork, aliases } = yield* forkBefore(native, history, next);
              if (eventFiber) yield* Fiber.interrupt(eventFiber);
              subscribed = false;
              ref = fork;
              thread = {
                ...thread!,
                nativeThreadRef: nativeRef(fork.sessionId),
                nativeMetadata: {
                  ...thread?.nativeMetadata,
                  messageAliases: aliases,
                },
              };
              providerTurns.clear();
              for (const turn of request.providerThreadTurns) {
                if (target && turn.ordinal <= target.ordinal)
                  providerTurns.set(turn.id, {
                    ...turn,
                    nativeTurnRef: turn.nativeTurnRef?.nativeId
                      ? nativeRef(resolveMessage(turn.nativeTurnRef.nativeId))
                      : turn.nativeTurnRef,
                  });
              }
              requests.clear();
              yield* startEvents();
              return yield* snapshot();
            }),
          ),
        forkThread: (request) =>
          turnGate.withPermit(
            Effect.gen(function* () {
              const native = yield* ownedThread(request.sourceProviderThread);
              if (active) return yield* error("Stop the Kilo task before forking");
              const boundary = request.providerTurnId
                ? request.sourceProviderTurns?.find((turn) => turn.id === request.providerTurnId)
                : undefined;
              if (request.providerTurnId && !boundary)
                return yield* error("Kilo fork boundary is unavailable");
              const history = yield* wire(client.history(native));
              const boundaryId = boundary?.nativeTurnRef?.nativeId;
              const boundaryIndex = boundaryId
                ? history.findIndex((m) => m.info.id === resolveMessage(boundaryId))
                : -1;
              if (boundary && boundaryIndex < 0)
                return yield* error("Kilo fork boundary no longer exists");
              const next = boundary
                ? history.slice(boundaryIndex + 1).find((m) => m.info.role === "user")?.info.id
                : undefined;
              const { fork, aliases } = yield* forkBefore(native, history, next);
              if (!thread) return yield* error("Kilo thread is not loaded");
              return {
                ...thread,
                id: ids.derive.providerThread({
                  driver: KILO_PROVIDER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: itemKey(fork.sessionId),
                }),
                nativeThreadRef: nativeRef(fork.sessionId),
                appThreadId: request.targetThreadId,
                nativeMetadata: {
                  ...thread.nativeMetadata,
                  messageAliases: aliases,
                  turnCorrelations: {},
                },
                providerSessionId: null,
                forkedFrom: {
                  providerThreadId: request.sourceProviderThread.id,
                  ...(request.providerTurnId ? { providerTurnId: request.providerTurnId } : {}),
                },
              };
            }),
          ),
      };
      return runtime;
    }),
  });
});
