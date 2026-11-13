/**
 * Routes OpenCode 2 stream events to sessions, turns and pending requests.
 */
import { Session } from "@opencode/client/effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as OpenCode2Client from "../OpenCode2Client.ts";
import { readableProviderErrorMessage } from "../../providerErrorMessage.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  INTERRUPT_TIMEOUT,
  claudeUsageLimit,
  stringField,
  subagentOutput,
  text,
  textOf,
} from "./protocol.ts";
import type { ActiveTurn, SubagentCall, ThreadState, Wake } from "./types.ts";
import type { Requests } from "./requests.ts";
import type { Turns } from "./turns.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeRouting = (
  deps: State & Projections & Config & Turns & Requests,
) => {
  const {
    announced,
    attachChild,
    busy,
    childOwners,
    clearing,
    emitCompaction,
    emitProviderThread,
    emitRetry,
    emitSubagent,
    emitText,
    emitTool,
    endExecution,
    endIfSettled,
    holderOf,
    input,
    live,
    onAsked,
    onReport,
    onWake,
    ordinalOf,
    ownerOf,
    pending,
    rootOf,
    settleCall,
    settleRequest,
    startChildTurn,
    strays,
    takeReports,
    threads,
    updateRetry,
    withReportedModel,
  } = deps;

  const sessionOfEvent = (event: OpenCode2Client.OpenCode2StreamEvent) =>
    event.type === "unreadable.execution.ended" || event.type === "unreadable.execution.started"
      ? event.sessionID
      : "sessionID" in event.data && typeof event.data.sessionID === "string"
        ? event.data.sessionID
        : undefined;

  const executionEnd = (type: string) =>
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted";

  const startCall = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    toolId: string,
  ) {
    const nativeId = `${turn.scope}${toolId}`;
    const call: SubagentCall = {
      toolId,
      nativeId,
      state,
      turn,
      ordinal: ordinalOf(turn, nativeId),
      startedAt: yield* DateTime.now,
      prompt: "",
      title: null,
      agent: undefined,
      model: null,
      background: false,
      joined: undefined,
      child: undefined,
      status: "running",
      result: null,
      completedAt: null,
    };
    turn.usedSubagents = true;
    state.calls.set(toolId, call);
    yield* emitSubagent(call);
  });

  const onTurnEvent = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    event: OpenCode2Client.OpenCode2StreamEvent,
  ) {
    // OpenCode sends nothing when a retry goes through; the provider's first output marks it.
    if (
      turn.retry !== undefined &&
      (event.type === "session.text.started" ||
        event.type === "session.reasoning.started" ||
        event.type === "session.tool.input.started")
    ) {
      yield* emitRetry(state, turn, "completed");
      turn.retry = undefined;
    }
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
        if (event.data.name === "question") return;
        if (event.data.name === "subagent") return yield* startCall(state, turn, event.data.id);
        turn.tools.set(event.data.id, { name: event.data.name, input: {} });
        turn.startedAt.set(event.data.id, yield* DateTime.now);
        return yield* emitTool(state, turn, event.data.id, "running");
      case "session.tool.called": {
        const call = state.calls.get(event.data.id);
        if (call !== undefined) {
          const { input } = event.data;
          call.prompt = stringField(input, "prompt") ?? call.prompt;
          call.title = stringField(input, "description") ?? call.title;
          call.agent = stringField(input, "agent");
          call.model = stringField(input, "model") ?? call.model;
          call.background = input["background"] === true;
          return yield* emitSubagent(call);
        }
        const tool = turn.tools.get(event.data.id);
        if (tool !== undefined) tool.input = event.data.input;
        return yield* emitTool(state, turn, event.data.id, "running");
      }
      case "session.tool.progress": {
        const call = state.calls.get(event.data.id);
        const childId = stringField(event.data.metadata, "sessionID");
        if (call !== undefined && childId !== undefined) yield* attachChild(call, childId);
        return;
      }
      case "session.tool.success": {
        const call = state.calls.get(event.data.id);
        if (call !== undefined) {
          const childId = stringField(event.data.metadata, "sessionID");
          if (childId !== undefined) yield* attachChild(call, childId);
          // Background and joined-background calls return at launch; reports settle them.
          if (event.data.metadata?.["status"] === "running") {
            if (call.background) return;
            call.background = true;
            return yield* emitSubagent(call);
          }
          return yield* settleCall(call, "completed", subagentOutput(textOf(event.data.content)));
        }
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
        const call = state.calls.get(event.data.id);
        if (call !== undefined) {
          return yield* settleCall(
            call,
            aborted ? "interrupted" : "failed",
            event.data.error.message,
          );
        }
        yield* emitTool(state, turn, event.data.id, aborted ? "interrupted" : "failed", {
          output: event.data.error.message,
          metadata: event.data.metadata,
        });
        turn.tools.delete(event.data.id);
        return;
      }
      case "session.compaction.started":
        turn.compaction = {
          nativeId: `${turn.providerTurn.id}:compaction:${turn.compactions++}`,
          startedAt: yield* DateTime.now,
        };
        return yield* emitCompaction(state, turn, "running");
      case "session.compaction.ended":
        return yield* emitCompaction(state, turn, "completed", event.data.text);
      case "session.compaction.failed":
        return yield* emitCompaction(state, turn, "failed");
      case "session.step.started":
        turn.startedSteps += 1;
        turn.models.add(`${event.data.model.providerID}/${event.data.model.id}`);
        return;
      case "session.step.ended":
      case "session.step.failed": {
        const tokens = event.data.tokens;
        if (tokens === undefined) return;
        turn.steps += 1;
        turn.lastStep = tokens;
        turn.usage.input += tokens.input + tokens.cache.read + tokens.cache.write;
        turn.usage.cached += tokens.cache.read;
        turn.usage.cacheWrite += tokens.cache.write;
        turn.usage.output += tokens.output + tokens.reasoning;
        turn.usage.reasoning += tokens.reasoning;
        return;
      }
      case "session.retry.scheduled":
        return yield* updateRetry(state, turn, event.data, event.data.at - event.created);
      case "session.execution.started":
        turn.heldEnd = undefined;
        return;
      case "session.execution.succeeded":
        return yield* endExecution(state, turn, {
          status: turn.interrupted ? "interrupted" : "completed",
        });
      case "session.execution.interrupted":
        return yield* endExecution(state, turn, { status: "interrupted" });
      case "session.execution.failed": {
        const { type, message, status, response } = event.data.error;
        // OpenCode types an empty balance as provider.quota too, but it answers
        // that with HTTP 402 and it never resets. Usage windows and budgets are 429.
        const claudeLimit = claudeUsageLimit(message);
        const usageLimit =
          (type === "provider.quota" && status !== 402) ||
          type === "provider.rate-limit" ||
          claudeLimit !== undefined;
        return yield* endExecution(state, turn, {
          status: "failed",
          failure: makeProviderFailure({
            message: readableProviderErrorMessage(message, status, response?.body),
            code: type,
            class: usageLimit ? "usage_limit" : "provider_error",
            resetAt: claudeLimit?.resetAt ?? null,
          }),
        });
      }
      default:
        return;
    }
  });

  const handleEvent = Effect.fnUntraced(function* (event: OpenCode2Client.OpenCode2StreamEvent) {
    const sessionId = sessionOfEvent(event);
    const cleared = sessionId === undefined ? undefined : clearing.get(sessionId);
    if (cleared !== undefined) {
      if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
        return yield* Deferred.succeed(cleared, undefined);
      }
      if (
        event.type === "session.execution.started" ||
        event.type === "unreadable.execution.started"
      ) {
        return;
      }
    }
    if (sessionId !== undefined) {
      if (
        event.type === "session.execution.started" ||
        event.type === "unreadable.execution.started"
      ) {
        // Executions are serial: a second start proves the unsettled run lost its end.
        const state = threads.get(sessionId);
        if (state?.unsettled === true) {
          if (state.unsettledStarted) state.unsettled = false;
          else state.unsettledStarted = true;
        }
        busy.add(sessionId);
      } else if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
        busy.delete(sessionId);
      }
    }
    if (event.type === "session.created" && event.data.parentID !== undefined) {
      const strayCaller = strays.get(event.data.parentID);
      if (strayCaller !== undefined) {
        strays.set(event.data.sessionID, strayCaller);
        return;
      }
      const owner = ownerOf(event.data.parentID);
      if (owner !== undefined) {
        childOwners.set(event.data.sessionID, owner);
        announced.set(event.data.sessionID, event.data);
        holderOf(event.data.parentID)?.wakes.at(-1)?.children.add(event.data.sessionID);
      }
      return;
    }
    const holder = sessionId === undefined ? undefined : holderOf(sessionId);
    const held = holder?.wakes.at(-1);
    if (holder !== undefined && held !== undefined) {
      held.events.push(event);
      if (
        sessionId === holder.sessionId &&
        (event.type === "unreadable.execution.ended" || executionEnd(event.type))
      ) {
        held.running = false;
      }
      return;
    }
    return yield* route(event, sessionId);
  });

  const route = Effect.fnUntraced(function* (
    event: OpenCode2Client.OpenCode2StreamEvent,
    sessionId: string | undefined,
    held = false,
  ) {
    const ended =
      !held && (event.type === "unreadable.execution.ended" || executionEnd(event.type))
        ? threads.get(sessionId ?? "")
        : undefined;
    if (ended?.unsettled === true) {
      ended.unsettled = false;
      return;
    }
    if (event.type === "unreadable.execution.started") {
      const turn = threads.get(event.sessionID)?.active;
      if (turn !== undefined) {
        turn.awaitingStart = false;
        turn.heldEnd = undefined;
        return;
      }
    }
    if (event.type === "unreadable.execution.ended") {
      const state = threads.get(event.sessionID);
      const turn = state?.active;
      if (state === undefined || turn === undefined || turn.awaitingStart) return;
      return yield* endExecution(
        state,
        turn,
        event.executionType === "session.execution.succeeded"
          ? { status: turn.interrupted ? "interrupted" : "completed" }
          : event.executionType === "session.execution.interrupted"
            ? { status: "interrupted" }
            : {
                status: "failed",
                failure: makeProviderFailure({
                  message: "OpenCode ended the turn with an error this version cannot read.",
                  class: "provider_error",
                }),
              },
      );
    }
    if (event.type === "permission.asked") {
      return yield* onAsked({ type: "permission", request: event.data });
    }
    if (event.type === "form.created")
      return yield* onAsked({ type: "form", form: event.data.form });
    if (
      event.type === "permission.replied" ||
      event.type === "form.replied" ||
      event.type === "form.cancelled"
    ) {
      const nativeId = event.type === "permission.replied" ? event.data.requestID : event.data.id;
      const entry = [...pending.values()].find((candidate) => candidate.native.id === nativeId);
      if (entry === undefined || entry.answering) return;
      const answered =
        event.type === "form.replied" ||
        (event.type === "permission.replied" && event.data.reply !== "reject");
      return yield* settleRequest(entry, answered ? "resolved" : "cancelled");
    }
    if (sessionId === undefined) return;
    const state = threads.get(sessionId);
    if (state === undefined) return;
    if (event.type === "session.model.selected" || event.type === "session.step.started") {
      if (event.type === "session.model.selected") state.model = event.data.model;
      const providerThread = withReportedModel(state.providerThread, event.data.model);
      if (providerThread !== state.providerThread) {
        state.providerThread = { ...providerThread, updatedAt: yield* DateTime.now };
        yield* emitProviderThread(state);
      }
    }
    if (
      event.type === "session.inbox.enqueued" &&
      state.subagent !== undefined &&
      state.active === undefined
    ) {
      state.subagent.queued ??= event.data.inboxID;
    }
    if (event.type === "session.inbox.enqueued" && event.data.item.type === "synthetic") {
      return yield* onReport(state, event.data.inboxID, event.data.item.payload);
    }
    if (event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered") {
      state.reports.delete(event.data.inboxID);
      const turn = state.active;
      if (turn !== undefined && turn.steers.delete(event.data.inboxID)) {
        turn.settledInbox.add(event.data.inboxID);
        if (event.type === "session.inbox.cancelled") yield* endIfSettled(state, turn);
      }
      return;
    }
    if (
      event.type === "session.inbox.enqueued" &&
      event.data.item.type === "user" &&
      state.subagent !== undefined &&
      state.subagent.prompt === undefined &&
      state.active === undefined
    ) {
      state.subagent.prompt = event.data.item.payload.text;
      return;
    }
    const started =
      event.type === "session.execution.started" || event.type === "unreadable.execution.started";
    if (state.subagent !== undefined && state.active === undefined && started) {
      if ((yield* takeReports(state)).stopped) {
        state.subagent.queued = undefined;
        return;
      }
      return yield* startChildTurn(state);
    }
    const turn = state.active;
    if (turn === undefined) {
      if (started && state.subagent === undefined) return yield* onWake(state);
      return;
    }
    if (turn.awaitingStart) {
      if (event.type === "session.execution.started") turn.awaitingStart = false;
      return;
    }
    return yield* onTurnEvent(state, turn, event);
  });

  // Terminal events are volatile; reconnects lose events and restarted servers cannot end lost executions.
  const replay = Effect.fnUntraced(function* (wake: Wake) {
    wake.dropped = true;
    for (const event of wake.events) yield* route(event, sessionOfEvent(event), true);
  });

  const discardWakes = (caller: ThreadState, wakes: ReadonlyArray<Wake>) => {
    const retired = new Set<string>();
    const retire = (childId: string) => {
      const info = announced.get(childId);
      if (info === undefined) return;
      announced.delete(childId);
      childOwners.delete(childId);
      strays.set(childId, caller);
      retired.add(childId);
      threads.get(info.parentID ?? "")?.stoppedChildren.add(childId);
    };
    for (const wake of wakes) {
      wake.dropped = true;
      for (const childId of wake.children) retire(childId);
    }
    for (let grew = retired.size > 0; grew;) {
      grew = false;
      for (const [childId, info] of announced) {
        if (info.parentID === undefined || !retired.has(info.parentID)) continue;
        retire(childId);
        grew = true;
      }
    }
  };

  // Stop strays serially outside lock; an unresponsive child must not block all events.
  const stopStrays = (thread: ThreadState) =>
    Effect.forEach(
      [...strays].flatMap(([childId, caller]) => (rootOf(caller) === thread ? [childId] : [])),
      (childId) =>
        live.client.session.interrupt({ sessionID: Session.ID.make(childId) }).pipe(
          Effect.asVoid,
          Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
          Effect.timeout(INTERRUPT_TIMEOUT),
          Effect.tap(() => Effect.sync(() => strays.delete(childId))),
          Effect.ignore({ log: true }),
        ),
      { discard: true },
    );

  return {
    sessionOfEvent,
    executionEnd,
    startCall,
    onTurnEvent,
    handleEvent,
    route,
    replay,
    discardWakes,
    stopStrays,
  };
};

export type Routing = ReturnType<typeof makeRouting>;
