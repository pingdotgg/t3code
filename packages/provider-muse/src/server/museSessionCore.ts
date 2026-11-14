import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  MUSE_DEFAULT_MODEL,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";

import type { MuseAdapterV2Options } from "./adapter.ts";
import { museItemStatus, museToolPresentation } from "./itemPresentation.ts";
import { MUSE_PROVIDER, MuseProviderCapabilitiesV2 } from "./museCapabilities.ts";
import { makeMuseChildPublishing } from "./museChildPublishing.ts";
import { makeMuseItemProjection } from "./museItemProjection.ts";
import type { ActiveTurn, ChildContext, Inbox, PendingRequest } from "./museSessionTypes.ts";
import { MuseSessionResult, type MuseItem, type MuseSubscriptionUsage } from "./protocol.ts";
import { museCanonicalPath, museWorkspaceRoot, type MuseSdkHost } from "./sdk.ts";
import { isMuseUsageLimitFailure, museUsageLimitResetAt } from "./usageLimits.ts";

const isOpenSessionError = Schema.is(ProviderAdapter.ProviderAdapterOpenSessionError);
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
const INFORMATIONAL_NOTIFICATIONS = new Set([
  "session/contextUsage",
  "session/tokenUsage",
  "session/todoListChanged",
  "turn/retryScheduled",
  "usage/changed",
]);
const TOOLS_WITH_NATIVE_ROWS = new Set(["write_todos", "request_user_input", "workflow"]);
const responseAnswerSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

export interface MuseSessionCoreDeps {
  readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  readonly options: MuseAdapterV2Options;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerHost: ProviderHost.ProviderHost["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly agentScope: AgentScopeShape;
}

/**
 * Owns the live Muse session: the host transport, the mutable session/thread/turn state, item
 * publishing, and turn settlement. Event routing and the adapter-facing runtime build on it.
 */
export const makeMuseSessionCore = Effect.fn("makeMuseSessionCore")(function* (
  deps: MuseSessionCoreDeps,
) {
    const { input, options, idAllocator, providerHost, fileSystem, mcpSessions, agentScope } = deps;
  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: MUSE_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });
  if (!options.settings.enabled) return yield* protocolError("Muse Code is disabled");
  if (input.runtimePolicy.interactionMode === "plan")
    return yield* protocolError("Muse Code does not support dedicated Plan mode");
  const scope = yield* Effect.scope;
  // Native realpath also corrects filesystem case, which Muse validates.
  const requestedCwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
  const cwd = yield* museCanonicalPath(requestedCwd);
  const workspaceRoot = yield* museWorkspaceRoot(cwd);
  const now = yield* DateTime.now;
  const state = {
    session: {
      id: input.providerSessionId,
      driver: MUSE_PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      cwd,
      model: input.modelSelection.model,
      capabilities: MuseProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    } as OrchestrationV2ProviderSession,
    host: undefined as MuseSdkHost | undefined,
    hostEpoch: 0,
    closed: false,
    broken: false,
    // Only idle host failures can be retried on this runtime.
    relaunchable: false,
    nativeSessionId: undefined as string | undefined,
    thread: undefined as OrchestrationV2ProviderThread | undefined,
    active: undefined as ActiveTurn | undefined,
    lastProviderTurn: undefined as OrchestrationV2ProviderTurn | undefined,
    latestSubscriptionUsage: undefined as MuseSubscriptionUsage | undefined,
    wake: undefined as
      | { readonly nativeId: string; readonly events: Array<[string, unknown]> }
      | undefined,
  };
  const events = yield* Queue.unbounded<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error | Cause.Done
  >();
  type Inbox =
    | { type: "notification"; method: string; params: unknown; epoch: number }
    | { type: "failure"; cause: unknown; epoch: number }
    | { type: "flush"; turn: ActiveTurn };
  const inbox = yield* Queue.unbounded<Inbox>();
  const commands = yield* Semaphore.make(1);
  const eventPermit = yield* Semaphore.make(1);

  const agentEndedAt = new Map<string, DateTime.Utc>();
  const resolveModel = Effect.fnUntraced(function* (selection: ModelSelection) {
    if (selection.model !== MUSE_DEFAULT_MODEL) return selection.model;
    const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
    return catalog.find((model) => model.isDefault && !model.isCustom)?.slug;
  });
  const pending = new Map<RuntimeRequestId, PendingRequest>();
  const seenTerminals = new Set<string>();
  const observedChildren = new Map<string, ActiveTurn>();
  const childrenByItemId = new Map<string, ChildContext>();
  const agentTitles = new Map<string, string>();
  const finishedBackground: Array<BackgroundWorkReport> = [];
  const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(events, event).pipe(Effect.asVoid);
  const projection = makeMuseItemProjection({ idAllocator, instanceId: options.instanceId });
  const { itemIdentity, baseItem, childItemIdentity, itemStatus, nativeRef, backgroundTaskId } =
    projection;
  const child = makeMuseChildPublishing({
    emit,
    pending,
    childrenByItemId,
    agentTitles,
    agentEndedAt,
    idAllocator,
    instanceId: options.instanceId,
    baseItem: projection.baseItem,
    childItemIdentity: projection.childItemIdentity,
    nativeRef: projection.nativeRef,
    backgroundTaskId: projection.backgroundTaskId,
  });
  const { publishChildRoot, publishChildMessage, ensureChildContext } = child;
  const { publishNativeSubagent, publishWorkflowAgents } = child;
  const decode = <A, I>(schema: Schema.Codec<A, I>, data: unknown) =>
    Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError((cause) => protocolError("Invalid Muse protocol response", cause)),
    );
  const request = (
    method: string,
    params: Record<string, unknown>,
    command = true,
    commandId?: string,
  ) =>
    Effect.tryPromise({
      try: () =>
        command
          ? state.host!.connection.command(
              method,
              { ...(state.nativeSessionId ? { sessionId: state.nativeSessionId } : {}), ...params },
              {
                ...(method === "turn/start" ? {} : { maxAttempts: 1 }),
                ...(commandId ? { commandId } : {}),
              },
            )
          : state.host!.connection.request(method, {
              ...(state.nativeSessionId ? { sessionId: state.nativeSessionId } : {}),
              ...params,
            }),
      catch: (cause) =>
        protocolError(
          cause instanceof Error && cause.message
            ? `Muse ${method} failed: ${cause.message}`
            : `Muse ${method} failed`,
          cause,
        ),
    }).pipe(
      Effect.timeout(options.requestTimeoutMs ?? 30_000),
      Effect.catchTags({
        // The enclosing operation owns the span for this inline handler.
        TimeoutError: Effect.fnUntraced(function* (cause) {
          yield* eventPermit.withPermits(1)(failHost(cause));
          return yield* protocolError(`Muse ${method} timed out; its host was closed`, cause);
        }),
      }),
    );
  const updateSession = Effect.fnUntraced(function* (
    status: OrchestrationV2ProviderSession["status"],
    lastError: string | null = null,
  ) {
    state.session = {
      ...state.session,
      status,
      // lastError is the thread banner, so it gets the failure item's bounded, redacted text.
      lastError:
        lastError === null ? null : makeProviderFailure({ message: lastError }).message,
      updatedAt: yield* DateTime.now,
    };
    yield* emit({
      type: "provider_session.updated",
      driver: MUSE_PROVIDER,
      providerSession: state.session,
    });
  });
  const updateThread = Effect.fnUntraced(function* (
    patch: Partial<OrchestrationV2ProviderThread>,
  ) {
    if (!state.thread) return;
    state.thread = { ...state.thread, ...patch, updatedAt: yield* DateTime.now };
    yield* emit({
      type: "provider_thread.updated",
      driver: MUSE_PROVIDER,
      providerThread: state.thread,
    });
  });
  const syncBackground = Effect.fnUntraced(function* () {
    yield* updateThread({
      pendingBackgroundTasks: [...observedChildren].flatMap(([itemId, owner]) => {
        const item = owner.items.get(itemId);
        const description = item?.objective ?? item?.entryId ?? item?.fallbackText;
        return [
          {
            taskId: item ? backgroundTaskId(item) : itemId,
            kind:
              item?.kind === "subagent" ? ("subagent" as const) : ("background_task" as const),
            ...(description ? { description } : {}),
          },
        ];
      }),
    });
  });
  const publishItem = Effect.fnUntraced(function* (
    turn: ActiveTurn,
    item: MuseItem,
    terminal?: OrchestrationV2TurnItem["status"],
  ) {
    // Muse's skill-reminder child runs on every model step; it is housekeeping, not work.
    if (item.kind === "userMessage" || item.kind === "reminderChild") return;
    if (
      item.kind === "toolCall" &&
      item.tool &&
      TOOLS_WITH_NATIVE_ROWS.has(item.tool) &&
      item.status !== "failed"
    )
      return;
    const time = yield* DateTime.now;
    const status = terminal ?? itemStatus(item);
    if (item.kind === "subagent" || item.kind === "workflow") {
      const wasRunning = observedChildren.has(item.itemId);
      if (status === "running") observedChildren.set(item.itemId, turn);
      else if (observedChildren.delete(item.itemId) && state.active !== turn)
        finishedBackground.push({
          kind: item.kind === "subagent" ? "subagent" : "background_task",
          label: item.objective ?? item.entryId ?? item.fallbackText,
          outcome:
            status === "completed"
              ? "completed"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
        });
      const running = observedChildren.has(item.itemId);
      // Muse reveals a subagent's ids over several revisions, so a running child is
      // relisted whenever the id its turn item carries moves.
      const listed = state.thread?.pendingBackgroundTasks?.some(
        (task) => task.taskId === backgroundTaskId(item),
      );
      if (wasRunning !== running || (running && !listed)) yield* syncBackground();
    }
    const streaming = status === "running";
    const base = {
      ...baseItem(turn, item.itemId, time),
      status,
      completedAt: streaming ? null : time,
      title: item.tool ?? null,
    };
    if (item.kind === "subagent") {
      yield* publishNativeSubagent(turn, item, base, status, time);
      return;
    }
    const text = item.text ?? item.summary?.join("\n") ?? item.fallbackText ?? "";
    let turnItem: OrchestrationV2TurnItem;
    if (item.kind === "agentMessage") {
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: itemIdentity(turn, item.itemId),
      });
      const message: OrchestrationV2ConversationMessage = {
        id: messageId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: base.nodeId,
        role: "assistant",
        text,
        attachments: [],
        streaming,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: base.startedAt,
        updatedAt: time,
      };
      yield* emit({ type: "message.updated", driver: MUSE_PROVIDER, message });
      turnItem = { ...base, type: "assistant_message", messageId, text, streaming };
    } else if (item.kind === "reasoning") {
      turnItem = { ...base, type: "reasoning", text, streaming };
    } else if (item.kind === "compaction") {
      turnItem = {
        ...base,
        type: "compaction",
        driver: MUSE_PROVIDER,
        summary: text || item.reason,
      };
    } else {
      turnItem = { ...base, ...museToolPresentation(item, status) };
    }
    yield* emit({
      type: "node.updated",
      driver: MUSE_PROVIDER,
      node: {
        id: base.nodeId,
        threadId: base.threadId,
        runId: base.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind:
          item.kind === "agentMessage"
            ? "assistant_message"
            : item.kind === "reasoning"
              ? "reasoning"
              : "tool_call",
        status,
        countsForRun: false,
        providerThreadId: base.providerThreadId,
        providerTurnId: base.providerTurnId,
        nativeItemRef: base.nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: base.startedAt,
        completedAt: base.completedAt,
      },
    });
    yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem });
    if (item.kind === "workflow") yield* publishWorkflowAgents(turn, item, base, status);
  });
  const settleObservedChildren = Effect.fnUntraced(function* (
    status: "failed" | "cancelled" | "interrupted",
  ) {
    for (const [itemId, owner] of observedChildren) {
      const item = owner.items.get(itemId);
      if (item) yield* publishItem(owner, item, status);
    }
    observedChildren.clear();
    if (state.thread?.pendingBackgroundTasks?.length) yield* syncBackground();
    for (const entry of pending.values()) yield* resolvePending(entry, "cancelled");
  });
  const resolvePending = Effect.fnUntraced(function* (
    entry: PendingRequest,
    status: "resolved" | "cancelled",
  ) {
    const time = yield* DateTime.now;
    entry.request = {
      ...entry.request,
      ...(status === "resolved" ? entry.response : undefined),
      status,
      resolvedAt: time,
      responseCapability: { type: "not_resumable", reason: "This Muse request has ended." },
    };
    entry.node = {
      ...entry.node,
      status: status === "resolved" ? "completed" : "cancelled",
      completedAt: time,
    };
    entry.item = {
      ...entry.item,
      status: status === "resolved" ? "completed" : "cancelled",
      completedAt: time,
      updatedAt: time,
    };
    pending.delete(entry.request.id);
    yield* emit({
      type: "runtime_request.updated",
      driver: MUSE_PROVIDER,
      threadId: input.threadId,
      runtimeRequest: entry.request,
    });
    yield* emit({ type: "node.updated", driver: MUSE_PROVIDER, node: entry.node });
    yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem: entry.item });
  });
  const finish = Effect.fnUntraced(function* (
    turn: ActiveTurn,
    status: "completed" | "cancelled" | "interrupted" | "failed",
    detail?: string,
    disposition: "reusable" | "broken" = "reusable",
    quota?: { readonly resetsAtMs: number },
  ) {
    if (state.active !== turn || seenTerminals.has(turn.nativeId)) return;
    seenTerminals.add(turn.nativeId);
    const completedAt = yield* DateTime.now;
    for (const item of turn.items.values()) {
      if (
        (item.kind === "subagent" || item.kind === "workflow") &&
        item.status === "inProgress" &&
        status === "completed" &&
        disposition === "reusable"
      )
        continue;
      if (turn.dirty.has(item.itemId) || item.status === "inProgress")
        yield* publishItem(turn, item, item.status === "inProgress" ? status : undefined);
    }
    turn.dirty.clear();
    for (const entry of pending.values())
      if (entry.request.providerTurnId !== null) yield* resolvePending(entry, "cancelled");
    turn.providerTurn = { ...turn.providerTurn, status, completedAt };
    state.lastProviderTurn = turn.providerTurn;
    yield* emit({
      type: "provider_turn.updated",
      driver: MUSE_PROVIDER,
      threadId: turn.input.threadId,
      providerTurn: turn.providerTurn,
    });
    yield* updateThread({
      status: disposition === "broken" ? "error" : "idle",
      ...(!turn.compact && status === "completed"
        ? { nativeConversationHeadRef: nativeRef(turn.nativeId) }
        : {}),
    });
    yield* updateSession(disposition === "broken" ? "error" : "ready", detail ?? null);
    state.active = undefined;
    if (status === "failed") {
      const usageLimited =
        disposition === "reusable" && (quota !== undefined || isMuseUsageLimitFailure(detail));
      const failure = makeProviderFailure({
        class:
          disposition === "broken"
            ? "transport_error"
            : usageLimited
              ? "usage_limit"
              : "provider_error",
        message: detail ?? "Muse turn failed.",
        ...(usageLimited
          ? {
              resetAt: museUsageLimitResetAt(
                state.latestSubscriptionUsage,
                DateTime.toEpochMillis(completedAt),
                { quota, message: detail },
              ),
            }
          : {}),
      });
      const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
      yield* emit({
        type: "turn_item.updated",
        driver: MUSE_PROVIDER,
        turnItem: {
          ...base,
          type: "error",
          status: "failed",
          title: usageLimited ? "Usage limit reached" : null,
          completedAt,
          failure,
        },
      });
      yield* emit({
        type: "turn.terminal",
        driver: MUSE_PROVIDER,
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        status,
        failure,
        failureItemOrdinal: base.ordinal,
        threadDisposition: disposition,
      });
    } else {
      yield* emit({
        type: "turn.terminal",
        driver: MUSE_PROVIDER,
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        status,
        failure: null,
        threadDisposition: disposition,
      });
    }
    yield* Deferred.succeed(turn.done, undefined);
  });
  const failHost = Effect.fnUntraced(function* (cause: unknown) {
    if (state.closed || state.broken) return;
    state.hostEpoch++;
    // Registration can replace the state.host while failure events are consumed.
    const failed = state.host!;
    const turn = state.active;
    state.broken = true;
    state.relaunchable = !turn;
    state.wake = undefined;
    const rootCause = Cause.isCause(cause) ? Cause.squash(cause) : cause;
    const failure = isOpenSessionError(rootCause) ? rootCause.cause : rootCause;
    const detail = isProtocolError(failure)
      ? failure.detail
      : failure instanceof Error
        ? failure.message
        : "Muse transport failed.";
    if (turn) yield* finish(turn, "failed", detail, "broken");
    else {
      yield* updateThread({ status: "error" });
      yield* updateSession("error", detail);
    }
    yield* settleObservedChildren("failed");
    if (turn) yield* Queue.fail(events, protocolError(detail, cause));
    yield* Effect.tryPromise(() => failed.close()).pipe(Effect.ignore, Effect.forkIn(scope));
  });
  const owns = (turn: ActiveTurn, turnId: string) =>
    turnId === turn.nativeId || turn.joined.has(turnId);
  const snapshot = Effect.fnUntraced(function* (
    current: OrchestrationV2ProviderThread,
  ): Effect.fn.Return<
    ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
    ProviderAdapter.ProviderAdapterV2Error
  > {
    const result = yield* request("session/read", { excludeItems: false }, false).pipe(
      Effect.flatMap((value) => decode(MuseSessionResult, value)),
    );
    if (result.session.sessionId !== state.nativeSessionId)
      return yield* protocolError("Muse snapshot belongs to a different session");
    const items = result.history?.items ?? result.history?.snapshot?.state.items ?? [];
    const now = yield* DateTime.now;
    return {
      providerThread: current,
      providerTurns: [],
      messages: items.flatMap((item): OrchestrationV2ConversationMessage[] =>
        item.kind === "agentMessage" || item.kind === "userMessage"
          ? [
              {
                id: idAllocator.derive.messageFromProviderItem({
                  driver: MUSE_PROVIDER,
                  nativeItemId: `${options.instanceId}:${current.id}:${item.turnId ?? "history"}:${item.itemId}`,
                }),
                threadId: current.appThreadId ?? input.threadId,
                runId: null,
                nodeId: null,
                role: item.kind === "agentMessage" ? "assistant" : "user",
                text: item.text ?? "",
                attachments: [],
                streaming: item.status === "inProgress",
                createdBy: item.kind === "agentMessage" ? "agent" : "user",
                creationSource: "provider",
                createdAt: now,
                updatedAt: now,
              },
            ]
          : [],
      ),
      runtimeRequests: [...pending.values()]
        .filter((entry) => entry.shown)
        .map((entry) => entry.request),
      providerPayload: items,
    };
  });
  return {
    input,
    snapshot,
    options,
    idAllocator,
    providerHost,
    fileSystem,
    mcpSessions,
    agentScope,
    scope,
    cwd,
    workspaceRoot,
    now,
    state,
    events,
    inbox,
    commands,
    eventPermit,
    agentEndedAt,
    resolveModel,
    pending,
    seenTerminals,
    observedChildren,
    childrenByItemId,
    agentTitles,
    finishedBackground,
    emit,
    decode,
    request,
    updateSession,
    updateThread,
    itemIdentity,
    baseItem,
    childItemIdentity,
    itemStatus,
    publishChildRoot,
    publishChildMessage,
    ensureChildContext,
    publishNativeSubagent,
    publishWorkflowAgents,
    syncBackground,
    publishItem,
    settleObservedChildren,
    resolvePending,
    finish,
    failHost,
    owns,
    backgroundTaskId,
    nativeRef,
    protocolError,
    recordSchema,
    INFORMATIONAL_NOTIFICATIONS,
    responseAnswerSchema,
    isProtocolError,
  };
});

export type MuseSessionCore = Effect.Success<ReturnType<typeof makeMuseSessionCore>>;
