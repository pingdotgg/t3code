/**
 * Owns the OpenCode 2 turn and subagent call lifecycle, from launch to settlement.
 */
import { Session } from "@opencode/client/effect";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  INTERRUPT_TIMEOUT,
  REQUEST_REPLY_TIMEOUT,
  ref,
  reportOutcome,
  stringField,
  subagentOutput,
  text,
  turnTokenUsage,
} from "./protocol.ts";
import type { ActiveTurn, PendingRequest, SubagentCall, ThreadState, TurnTerminal, Wake } from "./types.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeTurns = (
  deps: State & Projections & Config,
) => {
  const {
    announced,
    callsAbove,
    callsAttachedTo,
    childOwners,
    continuationRequests,
    directoryOf,
    driver,
    emit,
    emitCompaction,
    emitProviderThread,
    emitProviderTurn,
    emitRetry,
    emitText,
    emitTool,
    idAllocator,
    input,
    instanceId,
    live,
    makeTurn,
    markUnsettled,
    newThreadState,
    ordinalOf,
    pending,
    readModels,
    rootOf,
    sessionScope,
    setSessionStatus,
    strays,
    syncRosterAncestors,
    threads,
    windowOf,
    withReportedModel,
    writeRules,
  } = deps;

  const emitSubagent = Effect.fnUntraced(function* (call: SubagentCall) {
    const updatedAt = yield* DateTime.now;
    const { turn, state } = call;
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver,
      nativeItemId: call.nativeId,
    });
    const completedAt = isOrchestrationV2WorkActive(call.status)
      ? null
      : (call.completedAt ?? updatedAt);
    const childProviderThreadId = call.child?.providerThread.id ?? null;
    const childThreadId = call.child?.subagent?.appThread.id ?? null;
    yield* emit({
      type: "node.updated",
      driver,
      node: {
        id: nodeId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind: "subagent",
        status: call.status,
        countsForRun: false,
        providerThreadId: childProviderThreadId ?? state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(call.nativeId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: call.startedAt,
        completedAt,
      },
    });
    yield* emit({
      type: "subagent.updated",
      driver,
      subagent: {
        id: nodeId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: instanceId,
        providerThreadId: childProviderThreadId,
        childThreadId,
        nativeTaskRef: ref(call.nativeId),
        prompt: call.prompt,
        title: call.title,
        model: call.model,
        status: call.status,
        result: call.result,
        startedAt: call.startedAt,
        completedAt,
        updatedAt,
      },
    });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: call.nativeId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(call.nativeId),
        parentItemId: null,
        ordinal: call.ordinal,
        status: call.status,
        title: call.title,
        startedAt: call.startedAt,
        completedAt,
        updatedAt,
        type: "subagent",
        subagentId: nodeId,
        origin: "provider_native",
        driver,
        providerInstanceId: instanceId,
        childThreadId,
        prompt: call.prompt,
        result: call.result,
      },
    });
    yield* syncRosterAncestors(call.state);
  });

  const attachChild = Effect.fnUntraced(function* (call: SubagentCall, childId: string) {
    if (call.child !== undefined) return;
    const info = announced.get(childId);
    announced.delete(childId);
    const now = yield* DateTime.now;
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver,
      nativeItemId: call.nativeId,
    });
    const childThreadId = idAllocator.derive.threadFromProviderThread({
      driver,
      nativeThreadId: childId,
      providerInstanceId: instanceId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: childId,
      providerInstanceId: instanceId,
    });
    if (info?.model !== undefined) call.model = `${info.model.providerID}/${info.model.id}`;
    call.title = call.title ?? info?.title ?? null;
    const parentThread = call.turn.input.appThread;
    const appThread = makeSubagentChildThread({
      parentThread,
      childThreadId,
      parentNodeId: nodeId,
      activeProviderThreadId: providerThreadId,
      providerInstanceId: instanceId,
      modelSelection: {
        instanceId,
        model: call.model ?? call.turn.input.modelSelection.model,
      },
      title: subagentThreadTitle({
        parentTitle: parentThread.title,
        title: call.title,
        prompt: call.prompt,
        ordinal: call.ordinal,
      }),
      now,
      createdBy: "agent",
      creationSource: "provider",
    });
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId: input.providerSessionId,
      appThreadId: childThreadId,
      ownerNodeId: nodeId,
      nativeThreadRef: ref(childId),
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const previous = threads.get(childId);
    // Repeated subagent calls steer the same run; OpenCode reports it once for every joined call.
    if (previous?.active !== undefined) {
      call.joined = [...call.state.calls.values()].findLast(
        (candidate) =>
          candidate !== call && candidate.child === previous && candidate.joined === undefined,
      );
    }
    const subagent = {
      call,
      appThread,
      turns: previous?.subagent?.turns ?? 0,
      prompt: call.prompt,
      queued: undefined,
    };
    const child =
      previous ?? newThreadState(childId, providerThread, call.state.directory, subagent);
    child.subagent = subagent;
    child.model = info?.model ?? child.model;
    child.providerThread = withReportedModel(providerThread, child.model);
    child.directory = call.state.directory;
    child.agent = info?.agent ?? call.agent ?? child.agent;
    child.rules = info?.permissions ?? child.rules;
    threads.set(childId, child);
    childOwners.set(childId, rootOf(call.state));
    call.child = child;
    yield* emit({ type: "app_thread.created", driver, appThread });
    yield* emitProviderThread(child);
    yield* emitSubagent(call);
    // Reused child sessions may retain old mode rules; refresh policy as soon as the call identifies them.
    if (info === undefined) {
      yield* writeRules(child, rootOf(call.state).policy).pipe(
        Effect.timeout(REQUEST_REPLY_TIMEOUT),
        Effect.ignore({ log: true }),
      );
    }
  });

  const settleCall: (
    call: SubagentCall,
    status: OrchestrationV2Subagent["status"],
    result?: string,
  ) => Effect.Effect<void> = Effect.fnUntraced(function* (call, status, result) {
    if (!isOrchestrationV2WorkActive(call.status)) return;
    call.status = status;
    call.completedAt = yield* DateTime.now;
    if (result !== undefined) call.result = result;
    call.state.calls.delete(call.toolId);
    const child = call.child;
    if (child !== undefined) {
      for (const nested of Array.from(child.calls.values())) {
        if (nested.background && status !== "failed") continue;
        yield* settleCall(nested, status === "completed" ? "interrupted" : status);
      }
      if (child.active !== undefined && status !== "completed") {
        yield* finishTurn(child, { status: "interrupted" });
      }
      child.providerThread = {
        ...child.providerThread,
        status: "idle",
        updatedAt: call.completedAt,
      };
      yield* emitProviderThread(child);
    }
    yield* emitSubagent(call);
  });

  const startChildTurn = Effect.fnUntraced(function* (child: ThreadState) {
    const subagent = child.subagent;
    if (subagent === undefined || child.active !== undefined) return;
    subagent.turns += 1;
    const startedAt = yield* DateTime.now;
    const nativeTurnId = `${child.sessionId}:turn:${subagent.turns}`;
    const rootNodeId = idAllocator.derive.nodeFromProviderItem({
      driver,
      nativeItemId: `${nativeTurnId}:root`,
    });
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
      providerThreadId: child.providerThread.id,
      nodeId: rootNodeId,
      runAttemptId: null,
      nativeTurnRef: ref(nativeTurnId, "weak"),
      ordinal: subagent.turns,
      status: "running",
      startedAt,
      completedAt: null,
    };
    const turn = makeTurn(
      {
        appThread: subagent.appThread,
        threadId: subagent.appThread.id,
        runId: null,
        runOrdinal: subagent.call.turn.input.runOrdinal,
        rootNodeId,
        modelSelection: subagent.appThread.modelSelection,
        runtimePolicy: subagent.call.turn.input.runtimePolicy,
      },
      providerTurn,
      { scope: `${child.sessionId}:`, awaitingStart: false },
    );
    turn.before = subagent.queued;
    subagent.queued = undefined;
    child.active = turn;
    yield* emit({
      type: "node.updated",
      driver,
      node: {
        id: rootNodeId,
        threadId: turn.input.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: child.providerThread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: ref(nativeTurnId, "weak"),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt: null,
      },
    });
    yield* emitProviderTurn(child, turn, providerTurn);
    const prompt = subagent.prompt;
    subagent.prompt = undefined;
    if (prompt !== undefined && prompt.length > 0) {
      const nativeId = `${nativeTurnId}:prompt`;
      const artifacts = makeSubagentConversationArtifacts({
        messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId: nativeId }),
        senderThreadId: subagent.call.turn.input.threadId,
        turnItemId: idAllocator.derive.turnItemFromProviderItem({
          driver,
          nativeItemId: nativeId,
        }),
        threadId: turn.input.threadId,
        rootNodeId,
        providerThreadId: child.providerThread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: ref(nativeId, "weak"),
        role: "user",
        text: prompt,
        ordinal: ordinalOf(turn, nativeId),
        now: startedAt,
      });
      yield* emit({ type: "message.updated", driver, message: artifacts.message });
      yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
    }
  });

  const offerWake = Effect.fnUntraced(function* (state: ThreadState, wake: Wake) {
    const route = state.providerThread.appThreadId;
    if (route === null || wake.messageId === undefined) return;
    const notification = backgroundWorkNotification(wake.reports);
    yield* continuationRequests.offer({
      threadId: route,
      providerThreadId: state.providerThread.id,
      driver,
      detail: wake.detail,
      messageId: wake.messageId,
      ...(notification === null ? {} : { notification }),
      dispatchIfCurrent: (dispatch) =>
        wake.dropped ? Effect.succeedNone : Effect.asSome(dispatch),
    });
  });

  const finishTurn = Effect.fnUntraced(function* (
    state: ThreadState,
    terminal: TurnTerminal,
    threadDisposition: "reusable" | "broken" = "reusable",
  ) {
    const turn = state.active;
    if (turn === undefined) return;
    state.active = undefined;
    for (const inboxID of turn.steers) state.strandedSteers.add(inboxID);
    for (const entry of pending.values()) {
      const background = callsAbove(entry.sessionId).some((call) => call.background);
      if (
        entry.sessionId === state.sessionId ||
        (entry.turn === turn && !(background && terminal.status !== "failed"))
      ) {
        yield* settleRequest(entry, "cancelled");
      }
    }
    const completedAt = yield* DateTime.now;
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
    for (const call of Array.from(state.calls.values())) {
      if (call.turn !== turn) continue;
      if (call.background && terminal.status !== "failed") continue;
      yield* settleCall(call, terminal.status === "completed" ? "completed" : terminal.status);
    }
    if (state.subagent !== undefined) {
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: turn.input.rootNodeId,
          threadId: turn.input.threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: turn.input.rootNodeId,
          kind: "root_turn",
          status: terminal.status,
          countsForRun: false,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: turn.providerTurn.nativeTurnRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: turn.providerTurn.startedAt,
          completedAt,
        },
      });
    }
    yield* emitCompaction(state, turn, terminal.status === "failed" ? "failed" : "interrupted");
    yield* emitRetry(
      state,
      turn,
      terminal.status,
      terminal.status === "failed" ? terminal.failure : undefined,
    );
    const window = windowOf(turn.input.runtimePolicy.cwd, turn.input.modelSelection.model);
    const lastStep = turn.lastStep;
    yield* emitProviderTurn(state, turn, {
      ...turn.providerTurn,
      status: terminal.status,
      completedAt,
      turnTokenUsage: turnTokenUsage(turn, terminal.status),
      ...(lastStep === undefined
        ? {}
        : {
            tokenUsage: {
              usedTokens:
                lastStep.input + lastStep.cache.read + lastStep.cache.write + lastStep.output,
              maxTokens: window ?? null,
              inputTokens: lastStep.input + lastStep.cache.read + lastStep.cache.write,
              cachedInputTokens: lastStep.cache.read,
              outputTokens: lastStep.output,
              reasoningOutputTokens: lastStep.reasoning,
              updatedAt: DateTime.formatIso(completedAt),
            },
          }),
    });
    // Subagent turns are runless; their calls own settlement.
    if (state.subagent !== undefined) {
      const call = state.subagent.call;
      if (!call.background && terminal.status !== "completed") {
        yield* settleCall(call, terminal.status);
      }
      if (terminal.status === "failed") {
        // Background calls settle when the parent reads a report; failed children have no report.
        // Fail every attached call so earlier background calls cannot leave phantom work,
        // regardless of which call joined last or is still foreground.
        for (const attached of callsAttachedTo(state)) {
          yield* settleCall(attached, terminal.status, terminal.failure.message);
        }
      }
      return;
    }
    state.providerThread = {
      ...state.providerThread,
      status: threadDisposition === "broken" ? "error" : "idle",
      updatedAt: completedAt,
    };
    yield* emitProviderThread(state);
    const anyActive = [...threads.values()].some(
      (candidate) => candidate.subagent === undefined && candidate.active !== undefined,
    );
    yield* setSessionStatus(pending.size > 0 ? "waiting" : anyActive ? "running" : "ready", null);
    const base = {
      type: "turn.terminal" as const,
      driver,
      // Native forks change thread IDs; terminal events must retain the recorded start identity.
      providerThreadId: turn.providerTurn.providerThreadId,
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
            ...(turn.retry === undefined
              ? {}
              : { retry: turn.retry.retry, retryStartedAt: turn.retry.startedAt }),
          }
        : { ...base, status: terminal.status, failure: null },
    );
    // Cold servers list models lazily; refresh unknown windows off-stream for the next turn.
    if (window === undefined) {
      yield* Effect.forkIn(readModels(directoryOf(turn.input.runtimePolicy.cwd)), sessionScope);
    }
  });

  const forgetRequest = Effect.fnUntraced(function* (entry: PendingRequest) {
    if (!pending.delete(entry.request.id)) return false;
    if (pending.size === 0 && live.session.status === "waiting") {
      yield* setSessionStatus("running", null);
    }
    return true;
  });

  // The orchestrator already recorded T3-owned answers; only forget them here.
  const settleRequest = Effect.fnUntraced(function* (
    entry: PendingRequest,
    status: "resolved" | "cancelled",
  ) {
    if (!(yield* forgetRequest(entry)) || entry.answering) return;
    const now = yield* DateTime.now;
    const itemStatus = status === "resolved" ? "completed" : "cancelled";
    yield* emit({
      type: "runtime_request.updated",
      driver,
      threadId: entry.turn.input.threadId,
      runtimeRequest: { ...entry.request, status, resolvedAt: now },
    });
    yield* emit({
      type: "node.updated",
      driver,
      node: { ...entry.node, status: itemStatus, completedAt: now },
    });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: { ...entry.item, status: itemStatus, completedAt: now, updatedAt: now },
    });
  });

  const takeReports = Effect.fnUntraced(function* (state: ThreadState) {
    const delivered = [...state.reports.values()];
    state.reports.clear();
    const stopped =
      delivered.length > 0 &&
      delivered.every((entry) => state.stoppedChildren.has(entry.childId));
    for (const entry of delivered) state.stoppedChildren.delete(entry.childId);
    if (stopped) {
      markUnsettled(state);
      yield* live.client.session
        .interrupt({ sessionID: Session.ID.make(state.sessionId) })
        .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
    }
    return { delivered, stopped };
  });

  const onWake = Effect.fnUntraced(function* (state: ThreadState) {
    const { delivered, stopped } = yield* takeReports(state);
    if (stopped) return;
    const route = state.providerThread.appThreadId;
    const wake: Wake = {
      messageId:
        route === null
          ? undefined
          : yield* idAllocator.allocate.message({ threadId: route, ordinal: 0 }),
      events: [],
      running: true,
      reports: delivered.map((entry) => entry.report),
      detail: delivered.length === 0 ? null : delivered.map((entry) => entry.text).join("\n\n"),
      dropped: false,
      after: delivered.at(-1)?.inboxId,
      first: delivered[0]?.inboxId,
      children: new Set(),
    };
    state.wakes.push(wake);
    yield* Effect.logInfo("OpenCode started a turn on its own; asking for a continuation.", {
      providerThreadId: state.providerThread.id,
    });
    yield* offerWake(state, wake);
  });

  const onReport = Effect.fnUntraced(function* (
    state: ThreadState,
    inboxId: string,
    payload: {
      readonly text: string;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    const childId = stringField(payload.metadata, "childID");
    if (stringField(payload.metadata, "source") !== "subagent" || childId === undefined) return;
    strays.delete(childId);
    const call = [...state.calls.values()].find(
      (candidate) => candidate.child?.sessionId === childId,
    );
    const calls = [...state.calls.values()].filter(
      (candidate) => candidate === call || (call !== undefined && candidate.joined === call),
    );
    const outcome = reportOutcome(stringField(payload.metadata, "state"));
    state.reports.set(inboxId, {
      inboxId,
      childId,
      text: payload.text,
      report: {
        kind: "subagent",
        label: call?.title ?? stringField(payload.metadata, "description"),
        childThreadId: call?.child?.subagent?.appThread.id,
        outcome,
      },
    });
    const status = state.stoppedChildren.has(childId)
      ? "interrupted"
      : outcome === "failed"
        ? "failed"
        : outcome === "cancelled"
          ? "cancelled"
          : "completed";
    for (const each of calls) yield* settleCall(each, status, subagentOutput(payload.text));
  });

  const holderOf = (sessionId: string) => {
    const own = threads.get(sessionId);
    if (own !== undefined) return own.wakes.at(-1)?.running === true ? own : undefined;
    const parent = announced.get(sessionId)?.parentID;
    const holder = parent === undefined ? undefined : threads.get(parent);
    return holder !== undefined && holder.active === undefined && holder.wakes.length > 0
      ? holder
      : undefined;
  };

  // Undelivered steers start another execution owned by this turn; Stop starts nothing.
  const endExecution = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    end: TurnTerminal,
  ) {
    if (end.status === "completed" && turn.steers.size > 0) {
      turn.heldEnd = end;
      return;
    }
    yield* finishTurn(state, end);
  });

  const endIfSettled = (state: ThreadState, turn: ActiveTurn) =>
    turn.heldEnd !== undefined && turn.steers.size === 0
      ? finishTurn(state, turn.heldEnd)
      : Effect.void;

  return {
    emitSubagent,
    attachChild,
    settleCall,
    startChildTurn,
    offerWake,
    finishTurn,
    forgetRequest,
    settleRequest,
    takeReports,
    onWake,
    onReport,
    holderOf,
    endExecution,
    endIfSettled,
  };
};

export type Turns = ReturnType<typeof makeTurns>;
