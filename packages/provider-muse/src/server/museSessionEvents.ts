import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProcessExit } from "@muse-code/sdk";
import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";

import { MUSE_PROVIDER } from "./museCapabilities.ts";
import type { MuseSessionCore } from "./museSessionCore.ts";
import type { ActiveTurn, Inbox, PendingRequest } from "./museSessionTypes.ts";
import {
  MuseApproval,
  MuseContextUsage,
  MuseDelta,
  MuseItemEvent,
  MuseSubscriptionUsage,
  MuseTodoList,
  MuseTokenUsageEvent,
  MuseTurnCompleted,
  MuseTurnRetryScheduled,
  MuseUserInput,
  museApprovalChoices,
  museApprovalDecision,
  museApprovalOptions,
  type MuseItem,
} from "./protocol.ts";
import { createMuseSdkHostEffect } from "./sdk.ts";

/** Muse pushes everything over one host queue; this layer turns those frames into session state. */
export const makeMuseSessionEvents = Effect.fn("makeMuseSessionEvents")(function* (
  core: MuseSessionCore,
) {
  const {
    input,
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
  } = core;
  const decideApproval = Effect.fnUntraced(function* (
    entry: PendingRequest,
    decision: ProviderApprovalDecision | undefined,
  ) {
    if (entry.native.type !== "approval") return;
    const approval = entry.native.value;
    const choice = decision && museApprovalChoices(approval).get(decision);
    if (!choice) return yield* protocolError("Muse did not offer this approval decision");
    // Recorded first: Muse can settle the approval before it acknowledges the command.
    entry.response = { decision };
    yield* request("approval/decide", {
      approvalId: approval.approvalId,
      requirementId: approval.currentRequirementId,
      choiceId: choice.choiceId,
    }).pipe(Effect.tapError(() => Effect.sync(() => delete entry.response)));
  });
  const showRequest = Effect.fnUntraced(function* (entry: PendingRequest) {
    entry.shown = true;
    yield* emit({
      type: "runtime_request.updated",
      driver: MUSE_PROVIDER,
      threadId: entry.node.threadId,
      runtimeRequest: entry.request,
    });
    yield* emit({ type: "node.updated", driver: MUSE_PROVIDER, node: entry.node });
    yield* emit({ type: "turn_item.updated", driver: MUSE_PROVIDER, turnItem: entry.item });
    yield* updateSession("waiting");
  });
  /**
   * A workflow child's approval is runless: the turn that started the workflow
   * may end long before the child asks, and T3 keeps a runless request on the
   * state.thread until Muse settles it.
   */
  const publishRequest = Effect.fnUntraced(function* (native: PendingRequest["native"]) {
    const child = native.type === "approval" && native.value.subagentOrigin !== undefined;
    const turn = child ? undefined : state.active;
    if (
      !state.thread ||
      (!child && !turn) ||
      native.value.sessionId !== state.nativeSessionId ||
      (turn && native.value.turnId && !owns(turn, native.value.turnId))
    )
      return;
    const nativeId =
      native.type === "approval" ? native.value.approvalId : native.value.userInputId;
    if (turn?.settledRequests.has(`${native.type}:${nativeId}`)) return;
    const previous = [...pending.values()].find(
      (entry) =>
        entry.native.type === native.type &&
        entry.request.nativeRequestRef?.nativeId === nativeId,
    );
    const providerTurnId = turn?.providerTurn.id ?? null;
    const threadId = turn?.input.threadId ?? state.thread.appThreadId ?? input.threadId;
    const requestId =
      previous?.request.id ??
      (yield* idAllocator.allocate
        .runtimeRequest({
          driver: MUSE_PROVIDER,
          ...(providerTurnId ? { providerTurnId } : {}),
          nativeRequestId: nativeId,
        })
        .pipe(
          Effect.mapError((cause) => protocolError("Cannot allocate Muse request", cause)),
        ));
    const time = yield* DateTime.now;
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const subject = native.type === "approval" ? native.value.subject : undefined;
    const kind = !subject
      ? "user_input"
      : subject.kind === "shell"
        ? "command"
        : subject.kind !== "fileAccess"
          ? "permission"
          : subject.access === "read"
            ? "file-read"
            : "file-change";
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId,
      nativeRequestRef: nativeRef(nativeId),
      kind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: input.providerSessionId },
      createdAt: previous?.request.createdAt ?? time,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId: turn?.input.runId ?? null,
      parentNodeId: turn?.input.rootNodeId ?? null,
      rootNodeId: turn?.input.rootNodeId ?? nodeId,
      kind: native.type === "approval" ? "approval_request" : "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: state.thread.id,
      providerTurnId,
      nativeItemRef: nativeRef(nativeId),
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: runtimeRequest.createdAt,
      completedAt: null,
    };
    const latestTurn = state.active?.providerTurn ?? state.lastProviderTurn;
    const base = {
      ...(turn
        ? baseItem(turn, `request:${nativeId}`, time)
        : {
            threadId,
            runId: null,
            providerThreadId: state.thread.id,
            providerTurnId: null,
            nativeItemRef: nativeRef(nativeId),
            parentItemId: null,
            ordinal: previous?.item.ordinal ?? ((latestTurn?.ordinal ?? 0) + 1) * 100,
            startedAt: runtimeRequest.createdAt,
            updatedAt: time,
          }),
      id: idAllocator.derive.approvalTurnItem({ requestId }),
      nodeId,
      status: "waiting" as const,
      title: null,
      completedAt: null,
    };
    const item: OrchestrationV2TurnItem =
      native.type === "approval"
        ? {
            ...base,
            type: "approval_request",
            requestId,
            requestKind: kind === "user_input" ? "command" : kind,
            prompt:
              native.value.subject.command ??
              native.value.subject.path ??
              native.value.subject.host ??
              native.value.subject.target ??
              native.value.toolName ??
              "Muse requests permission",
            options: museApprovalOptions(native.value),
          }
        : {
            ...base,
            type: "user_input_request",
            requestId,
            questions: native.value.questions.map((question) => ({
              id: question.id,
              header: question.header || "Question",
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description || option.label,
              })),
              multiSelect: question.selection.mode === "multiple",
              allowCustomAnswer: true,
              required: true,
            })),
          };
    // Muse does not propagate allowAll to workflow children; T3 answers for them.
    const autoApprove = child && input.runtimePolicy.runtimeMode === "full-access";
    const entry: PendingRequest = {
      native,
      request: runtimeRequest,
      node,
      item,
      shown: !autoApprove || previous?.shown === true,
    };
    pending.set(requestId, entry);
    if (entry.shown) yield* showRequest(entry);
    if (autoApprove)
      yield* decideApproval(entry, "accept").pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            // Native updates may settle or replace this entry while the RPC is in flight.
            if (!state.closed && !state.broken && pending.get(requestId) === entry)
              yield* showRequest(entry);
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );
  });
  const handleRequestEvent = Effect.fnUntraced(function* (
    method: string,
    params: Record<string, unknown>,
    turn: ActiveTurn | undefined,
  ) {
    switch (method) {
      case "approval/requested":
      case "approval/updated":
        if (
          method === "approval/updated" &&
          ![...pending.values()].some(
            (entry) =>
              entry.native.type === "approval" &&
              entry.native.value.approvalId === params.approvalId,
          )
        )
          return;
        return yield* publishRequest({
          type: "approval",
          value: yield* decode(MuseApproval, params),
        });
      case "userInput/requested":
        return yield* publishRequest({
          type: "question",
          value: yield* decode(MuseUserInput, params),
        });
      case "approval/resolved":
      case "userInput/settled": {
        const id = method === "approval/resolved" ? params.approvalId : params.userInputId;
        if (typeof id === "string")
          turn?.settledRequests.add(
            `${method === "approval/resolved" ? "approval" : "question"}:${id}`,
          );
        const entry = [...pending.values()].find(
          (candidate) => candidate.request.nativeRequestRef?.nativeId === id,
        );
        if (entry) {
          const native =
            method === "approval/resolved" && typeof params.decision === "string"
              ? museApprovalDecision({ decision: params.decision, scope: "once" })
              : undefined;
          if (!entry.response && native) entry.response = { decision: native };
          yield* resolvePending(entry, "resolved");
        }
        if (![...pending.values()].some((candidate) => candidate.shown))
          yield* updateSession(state.active ? "running" : "ready");
      }
    }
  });
  const handleNotification = Effect.fnUntraced(function* (method: string, data: unknown) {
    const params = yield* decode(recordSchema, data);
    // usage/changed is account-wide and carries no state.session ID.
    if (method === "usage/changed") {
      state.latestSubscriptionUsage = yield* decode(MuseSubscriptionUsage, params);
      return;
    }
    if (params.sessionId !== state.nativeSessionId) return;
    if (method === "view/gap")
      return yield* protocolError("Muse delivery gap requires session recovery");
    if (method === "session/contextUsage") {
      const usage = yield* decode(MuseContextUsage, params);
      const currentTurn = state.active?.providerTurn ?? state.lastProviderTurn;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const tokenUsage = {
        ...currentTurn?.tokenUsage,
        usedTokens: usage.usedTokens,
        maxTokens: usage.windowTokens ?? currentTurn?.tokenUsage?.maxTokens ?? undefined,
        updatedAt,
      };
      yield* updateThread({ contextUsage: tokenUsage });
      if (currentTurn) {
        const updated = { ...currentTurn, tokenUsage };
        if (state.active) state.active.providerTurn = updated;
        else state.lastProviderTurn = updated;
        yield* emit({
          type: "provider_turn.updated",
          driver: MUSE_PROVIDER,
          providerTurn: updated,
        });
      }
      return;
    }
    const itemEvent = ["item/started", "item/updated", "item/completed"].includes(method)
      ? (yield* decode(MuseItemEvent, params)).item
      : undefined;
    if (itemEvent) {
      const owner = observedChildren.get(itemEvent.itemId);
      if (owner && owner !== state.active && itemEvent.turnId === owner.nativeId) {
        const previous = owner.items.get(itemEvent.itemId);
        if (!previous || itemEvent.revision > previous.revision) {
          owner.items.set(itemEvent.itemId, itemEvent);
          yield* publishItem(owner, itemEvent);
        }
        return;
      }
    }
    // Child approvals use their own run IDs and can outlive turns; bypass turn routing.
    if (params.subagentOrigin !== undefined && method.startsWith("approval/"))
      return yield* handleRequestEvent(method, params, undefined);
    if (
      method === "turn/started" &&
      typeof params.turnId === "string" &&
      params.turnId !== state.active?.nativeId &&
      params.turnId !== state.wake?.nativeId
    ) {
      if (state.active && !state.active.compact) state.active.joined.add(params.turnId);
      else if (!state.active && !state.wake) {
        const held = { nativeId: params.turnId, events: [] };
        state.wake = held;
        const notification = backgroundWorkNotification(finishedBackground.splice(0));
        if (state.thread?.appThreadId && options.continuationRequests)
          yield* options.continuationRequests.offer({
            threadId: state.thread.appThreadId,
            providerThreadId: state.thread.id,
            driver: MUSE_PROVIDER,
            detail: null,
            ...(notification ? { notification } : {}),
            dispatchIfCurrent: (dispatch) =>
              state.wake === held ? Effect.asSome(dispatch) : Effect.succeedNone,
            clearIfCurrent: () =>
              Effect.sync(() => {
                if (state.wake === held) state.wake = undefined;
              }),
          });
      }
    }
    if (state.wake && state.active?.nativeId !== state.wake.nativeId) {
      const turnId = typeof params.turnId === "string" ? params.turnId : itemEvent?.turnId;
      if (turnId === state.wake.nativeId) {
        state.wake.events.push([method, data]);
        return;
      }
    }
    const turn = state.active;
    if (!turn) return;
    if (typeof params.turnId === "string" && !owns(turn, params.turnId) && !turn.compact)
      return;
    switch (method) {
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const item = itemEvent!;
        if (
          item.turnId &&
          !owns(turn, item.turnId) &&
          !(turn.compact && item.kind === "compaction")
        )
          return;
        const previous = turn.items.get(item.itemId);
        if (previous && previous.revision >= item.revision) return;
        turn.items.set(item.itemId, item);
        turn.dirty.delete(item.itemId);
        yield* publishItem(turn, item);
        if (turn.compact && item.kind === "compaction" && item.status !== "inProgress") {
          yield* finish(
            turn,
            item.status === "completed" && (!item.outcome || item.outcome === "compacted")
              ? "completed"
              : item.status === "cancelled"
                ? "cancelled"
                : "failed",
            item.failureReason ?? item.reason,
          );
        }
        break;
      }
      case "item/delta": {
        const delta = yield* decode(MuseDelta, params);
        const previous = turn.items.get(delta.itemId);
        if (!previous || previous.status !== "inProgress") return;
        const field = delta.field ?? "text";
        let item = previous;
        if (field === "text") item = { ...previous, text: (previous.text ?? "") + delta.delta };
        else if (field === "output" || field === "visibleOutput")
          item = { ...previous, visibleOutput: (previous.visibleOutput ?? "") + delta.delta };
        else if (field.startsWith("summary.")) {
          const index = Number(field.slice(8));
          if (Number.isSafeInteger(index) && index >= 0 && index < 100) {
            const summary = [...(previous.summary ?? [])];
            summary[index] = (summary[index] ?? "") + delta.delta;
            item = { ...previous, summary };
          }
        }
        if (item === previous) return;
        turn.items.set(item.itemId, item);
        turn.dirty.add(item.itemId);
        if (!turn.flushScheduled) {
          turn.flushScheduled = true;
          yield* Effect.sleep(50).pipe(
            Effect.andThen(Queue.offer(inbox, { type: "flush", turn })),
            Effect.forkIn(scope),
          );
        }
        break;
      }
      case "turn/completed": {
        if (turn.compact) return;
        const result = yield* decode(MuseTurnCompleted, params);
        // A joined Muse turn ending does not end this run; its own turn does.
        if (result.turnId !== turn.nativeId) break;
        if (result.usage) {
          const usage = result.usage;
          turn.providerTurn = {
            ...turn.providerTurn,
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
              inputTokens: turn.providerTurn.turnTokenUsage?.inputTokens ?? usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cacheReadTokens ?? usage.cachedTokens,
              reasoningTokens: usage.reasoningTokens,
              ...(usage.cacheWriteTokens === undefined
                ? {}
                : { cacheCreationTokens: usage.cacheWriteTokens }),
            },
          };
        }
        const status =
          result.terminal === "completed"
            ? "completed"
            : result.terminal === "cancelled"
              ? turn.interruptRequested
                ? "interrupted"
                : "cancelled"
              : "failed";
        yield* finish(
          turn,
          status,
          result.error?.message ?? result.reason,
          "reusable",
          result.error?.quota,
        );
        break;
      }
      case "approval/requested":
      case "approval/updated":
      case "approval/resolved":
      case "userInput/requested":
      case "userInput/settled":
        yield* handleRequestEvent(method, params, turn);
        break;
      case "session/tokenUsage": {
        const usage = yield* decode(MuseTokenUsageEvent, params);
        const previous = turn.providerTurn.turnTokenUsage;
        const contextUsage = state.thread?.contextUsage;
        turn.providerTurn = {
          ...turn.providerTurn,
          ...(contextUsage
            ? {
                tokenUsage: {
                  ...turn.providerTurn.tokenUsage,
                  usedTokens: contextUsage.usedTokens,
                  inputTokens: usage.usage.inputTokens,
                  outputTokens: usage.usage.outputTokens,
                  cachedInputTokens: usage.usage.cacheReadTokens ?? usage.usage.cachedTokens,
                  reasoningOutputTokens: usage.usage.reasoningTokens,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                },
              }
            : {}),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
            inputTokens: (previous?.inputTokens ?? 0) + usage.promptTokens,
            outputTokens: (previous?.outputTokens ?? 0) + usage.usage.outputTokens,
            cachedInputTokens:
              (previous?.cachedInputTokens ?? 0) +
              (usage.usage.cacheReadTokens ?? usage.usage.cachedTokens),
            ...(usage.usage.cacheWriteTokens === undefined &&
            previous?.cacheCreationTokens === undefined
              ? {}
              : {
                  cacheCreationTokens:
                    (previous?.cacheCreationTokens ?? 0) + (usage.usage.cacheWriteTokens ?? 0),
                }),
            reasoningTokens: (previous?.reasoningTokens ?? 0) + usage.usage.reasoningTokens,
          },
        };
        yield* emit({
          type: "provider_turn.updated",
          driver: MUSE_PROVIDER,
          providerTurn: turn.providerTurn,
        });
        break;
      }
      case "session/todoListChanged": {
        const todo = yield* decode(MuseTodoList, params);
        const steps: ReadonlyArray<OrchestrationV2PlanStep> = todo.items
          .filter((item) => item.text.trim() && item.status !== "cancelled")
          .map((item, index) => ({
            id: `${turn.nativeId}:todo:${index}`,
            text: item.text.trim(),
            status:
              item.status === "completed"
                ? "completed"
                : item.status === "inProgress"
                  ? "running"
                  : "pending",
          }));
        const time = yield* DateTime.now;
        const base = baseItem(turn, "todo", time);
        const planId =
          turn.todoPlanId ??
          (yield* idAllocator.allocate
            .plan({
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              driver: MUSE_PROVIDER,
            })
            .pipe(
              Effect.mapError((cause) =>
                protocolError("Cannot allocate Muse todo list", cause),
              ),
            ));
        turn.todoPlanId = planId;
        yield* emit({
          type: "plan.updated",
          driver: MUSE_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
          },
        });
        yield* emit({
          type: "node.updated",
          driver: MUSE_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind: "todo_list",
            status: "completed",
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt: time,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: MUSE_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: null,
            type: "todo_list",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            steps,
          },
        });
        break;
      }
      case "turn/retryScheduled": {
        const retry = yield* decode(MuseTurnRetryScheduled, params);
        const time = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: MUSE_PROVIDER,
          turnItem: {
            ...baseItem(turn, `retry:${retry.nextAttempt}`, time),
            type: "system_notice",
            status: "completed",
            title: "Muse retry",
            completedAt: time,
            message: `Muse is retrying this turn (attempt ${retry.nextAttempt} of ${retry.maxAttempts}): ${retry.reason}`,
          },
        });
        break;
      }
    }
  });
  yield* Stream.fromQueue(inbox).pipe(
    Stream.runForEach((entry) =>
      Effect.gen(function* () {
        if (entry.type === "flush") {
          const turn = entry.turn;
          turn.flushScheduled = false;
          if (state.active !== turn) return;
          for (const id of turn.dirty) {
            const item = turn.items.get(id);
            if (item) yield* publishItem(turn, item);
          }
          turn.dirty.clear();
        } else if (entry.epoch === state.hostEpoch) {
          if (entry.type === "failure") yield* failHost(entry.cause);
          else {
            if (options.nativeEventLogger && entry.method !== "item/delta")
              yield* options.nativeEventLogger.write(
                { provider: "muse", method: entry.method, params: entry.params },
                input.threadId,
              );
            yield* handleNotification(entry.method, entry.params).pipe(
              Effect.catch((cause) =>
                INFORMATIONAL_NOTIFICATIONS.has(entry.method)
                  ? Effect.logWarning(`Skipped an unreadable Muse ${entry.method}`, cause)
                  : failHost(cause),
              ),
            );
          }
        }
      }).pipe(eventPermit.withPermits(1)),
    ),
    Effect.forkIn(scope),
  );
    return {
      decideApproval,
      showRequest,
      publishRequest,
      handleRequestEvent,
      handleNotification,
    };
});

export type MuseSessionEvents = Effect.Success<ReturnType<typeof makeMuseSessionEvents>>;
