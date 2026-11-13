/**
 * Follows the OpenCode 2 event stream, reconnecting and reconciling after loss.
 */
import { Session } from "@opencode/client/effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as OpenCode2Client from "../OpenCode2Client.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  LOST_BACKGROUND,
  RECONCILE_TIMEOUT,
  RECONNECT_ATTEMPTS,
  RECONNECT_DELAY,
  promptOf,
  text,
  textOf,
} from "./protocol.ts";
import type { ThreadState } from "./types.ts";
import type { Routing } from "./routing.ts";
import type { Requests } from "./requests.ts";
import type { Turns } from "./turns.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeLifecycle = (
  deps: State & Projections & Config & Turns & Requests & Routing,
) => {
  const {
    borrow,
    busy,
    callsAbove,
    discardWakes,
    emitRetry,
    emitText,
    emitTool,
    events,
    executionEnd,
    finishTurn,
    handleEvent,
    hasBackground,
    live,
    lock,
    onAsked,
    ownerOf,
    pending,
    rootOf,
    runningCalls,
    sessionOfEvent,
    sessionScope,
    sessionsOf,
    setSessionStatus,
    settleCall,
    settleRequest,
    stopStrays,
    strays,
    syncRoster,
    syncRosterAncestors,
    threads,
    updateRetry,
  } = deps;

  const failAll = Effect.fnUntraced(function* (message: string) {
    live.streamFailure = message;
    yield* Deferred.succeed(live.reconnected, undefined);
    for (const state of threads.values()) {
      const failure = makeProviderFailure({ message, class: "transport_error" });
      yield* finishTurn(state, { status: "failed", failure }, "broken");
    }
    for (const state of threads.values()) {
      for (const call of runningCalls(state)) yield* settleCall(call, "failed");
      for (const wake of state.wakes.splice(0)) wake.dropped = true;
      state.reports.clear();
    }
    yield* setSessionStatus("error", message);
    yield* Queue.end(events);
  });

  const backfill = Effect.fnUntraced(function* (sessionId: string, state: ThreadState) {
    const turn = state.active;
    if (turn === undefined) return undefined;
    const promptId = promptOf(turn.providerTurn);
    const { before } = turn;
    if (promptId === undefined && before === undefined) return undefined;
    const start = before !== undefined ? before : promptId;
    const read = yield* OpenCode2Client.paginate(
      { sessionID: Session.ID.make(sessionId), order: "desc" as const, limit: 50 },
      live.client.message.list,
    ).pipe(
      Stream.takeUntil((message) => message.id === start),
      Stream.runCollect,
    );
    // Without this turn's start in history, all retrieved turns are older.
    const found = start === null || read.at(-1)?.id === start;
    if (!found) return undefined;
    const recent = before !== undefined && before !== null ? read.slice(0, -1) : read;
    const idle = recent.find((message) => message.type === "idle");
    const assistant = recent.find((message) => message.type === "assistant");
    if (assistant?.retry !== undefined) {
      // Snapshots omit when the retry was scheduled, so only its remaining delay is known.
      yield* updateRetry(
        state,
        turn,
        assistant.retry,
        DateTime.toEpochMillis(assistant.retry.at) - DateTime.toEpochMillis(yield* DateTime.now),
      );
    } else if (
      turn.retry !== undefined &&
      assistant !== undefined &&
      assistant.error === undefined &&
      assistant.content.length > 0
    ) {
      yield* emitRetry(state, turn, "completed");
      turn.retry = undefined;
    }
    for (const message of recent.toReversed()) {
      if (message.type !== "assistant" || state.active !== turn) continue;
      const ordinals = { text: 0, reasoning: 0 };
      for (const [index, part] of message.content.entries()) {
        if (part.type === "text" || part.type === "reasoning") {
          const block = { assistantMessageID: message.id, ordinal: ordinals[part.type]++ };
          // OpenCode saves a block's text only when the block ends, so the last block of a
          // response still streaming stays open and keeps the text that already arrived.
          const open =
            message.time.streamed === undefined && index === message.content.length - 1;
          yield* emitText(
            state,
            turn,
            block,
            part.type,
            (text) => (open && !part.text.startsWith(text) ? text : part.text),
            !open,
          );
          continue;
        }
        if (part.type !== "tool") continue;
        if (!turn.tools.has(part.id)) {
          turn.tools.set(part.id, { name: part.name, input: {} });
          turn.startedAt.set(part.id, yield* DateTime.now);
        }
        const tool = turn.tools.get(part.id)!;
        if (typeof part.state.input === "object" && part.state.input !== null) {
          tool.input = part.state.input as Record<string, unknown>;
        }
        if (part.state.status === "completed") {
          yield* emitTool(state, turn, part.id, "completed", {
            output: textOf(part.state.content),
            metadata: part.state.metadata,
          });
          turn.tools.delete(part.id);
        } else if (part.state.status === "error") {
          yield* emitTool(state, turn, part.id, "failed", {
            output: part.state.error.message,
            metadata: part.state.metadata,
          });
          turn.tools.delete(part.id);
        } else {
          yield* emitTool(state, turn, part.id, "running");
        }
      }
    }
    return idle === undefined ? undefined : { outcome: idle.outcome };
  });

  // Restarts retain the previous session.outcome; without an idle item, the lost execution was interrupted.
  const reconcile = Effect.gen(function* () {
    // Read deepest sessions first; subagent turns end before their waiting parents.
    const running = [...threads]
      .filter(([, state]) => state.active !== undefined)
      .toSorted(([left], [right]) => callsAbove(right).length - callsAbove(left).length);
    const background = [...threads.values()].filter(
      (state) => state.subagent === undefined && hasBackground(state),
    );
    const marked = [...threads.values()].some((state) => state.unsettled);
    if (
      running.length === 0 &&
      background.length === 0 &&
      busy.size === 0 &&
      !marked &&
      strays.size === 0
    ) {
      return;
    }
    const active = yield* live.client.session.active();
    for (const sessionId of busy) if (!(sessionId in active)) busy.delete(sessionId);
    for (const state of threads.values()) {
      if (state.unsettled && !(state.sessionId in active)) state.unsettledStarted = true;
    }
    for (const childId of strays.keys()) if (!(childId in active)) strays.delete(childId);
    for (const [sessionId, state] of running) {
      const turn = state.active;
      if (turn === undefined) continue;
      turn.missedEvents = true;
      const ended = yield* backfill(sessionId, state);
      if (sessionId in active || state.active !== turn) continue;
      yield* finishTurn(
        state,
        ended?.outcome === "succeeded"
          ? { status: turn.interrupted ? "interrupted" : "completed" }
          : ended?.outcome === "failed"
            ? {
                status: "failed",
                failure: makeProviderFailure({
                  message:
                    "OpenCode ended the turn with an error while T3 Code was reconnecting.",
                  class: "provider_error",
                }),
              }
            : { status: "interrupted" },
      );
    }
    for (const state of background) {
      for (const call of runningCalls(state)) {
        const child = call.child?.sessionId;
        if (child === undefined || !(child in active)) {
          yield* settleCall(call, "interrupted", LOST_BACKGROUND);
        }
      }
      const sessions = sessionsOf(state);
      for (const each of sessions) {
        discardWakes(each, each.wakes.splice(0));
        each.reports.clear();
      }
      for (const each of sessions.toReversed()) yield* syncRoster(each);
    }
    // Stopped off the lock this reconcile holds; one still running waits for a Stop.
    for (const thread of new Set([...strays.values()].map(rootOf))) {
      yield* Effect.forkIn(stopStrays(thread), sessionScope);
    }
    const listed = new Map<string, Set<string>>();
    for (const sessionId of Object.keys(active)) {
      if (ownerOf(sessionId) === undefined) continue;
      const sessionID = Session.ID.make(sessionId);
      const [permissions, forms] = yield* Effect.all([
        live.client.permission.list({ sessionID }),
        live.client.session.form.list({ sessionID }),
      ]);
      listed.set(sessionId, new Set([...permissions, ...forms].map((request) => request.id)));
      const shown = new Set([...pending.values()].map((entry) => entry.native.id));
      for (const request of permissions) {
        if (!shown.has(request.id)) yield* onAsked({ type: "permission", request });
      }
      for (const form of forms) {
        if (!shown.has(form.id)) yield* onAsked({ type: "form", form });
      }
    }
    for (const entry of Array.from(pending.values())) {
      if (listed.get(entry.sessionId)?.has(entry.native.id) !== true) {
        yield* settleRequest(entry, "cancelled");
      }
    }
  });

  const reconnect = Effect.gen(function* () {
    // Release the borrow on every failure, including reconnect interruption, so spawned servers can idle-stop.
    const scope = yield* Scope.make();
    const { next, stream } = yield* Effect.gen(function* () {
      const next = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
      return { next, stream: yield* next.events };
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    const previous = live.currentScope;
    live.connection = next;
    live.client = next.client;
    live.currentScope = scope;
    yield* Scope.close(previous, Exit.void);
    // A restarted server forgot T3's MCP servers; the next turn adds them again.
    for (const state of threads.values()) state.mcp = undefined;
    yield* lock.withPermit(reconcile).pipe(Effect.timeout(RECONCILE_TIMEOUT));
    return stream;
  }).pipe(
    Effect.retry({ times: RECONNECT_ATTEMPTS - 1, schedule: Schedule.spaced(RECONNECT_DELAY) }),
  );

  const follow = (
    stream: Stream.Stream<OpenCode2Client.OpenCode2StreamEvent, unknown>,
  ): Effect.Effect<void> =>
    stream.pipe(
      Stream.runForEach((event) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* handleEvent(event);
            if (
              event.type === "session.execution.started" ||
              event.type === "unreadable.execution.started" ||
              executionEnd(event.type) ||
              event.type === "unreadable.execution.ended" ||
              event.type === "session.inbox.enqueued" ||
              event.type === "session.inbox.delivered" ||
              event.type === "session.inbox.cancelled"
            ) {
              const sessionId = sessionOfEvent(event);
              const state = sessionId === undefined ? undefined : threads.get(sessionId);
              if (state !== undefined) yield* syncRosterAncestors(state);
            }
          }),
        ),
      ),
      Effect.exit,
      Effect.flatMap(() =>
        Effect.gen(function* () {
          live.streamFailure = "The OpenCode event stream was lost. Reconnecting.";
          yield* Effect.logWarning("Lost the OpenCode event stream; reconnecting.");
          // Failures may contain URLs or response text; annotate only the tag and keep details in cause.
          const next = yield* reconnect.pipe(
            Effect.tapCause((cause) =>
              Effect.logWarning(
                "Could not reconnect to the OpenCode event stream; failing the session.",
                cause,
              ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
            ),
            Effect.option,
          );
          if (next._tag === "None") {
            return yield* failAll("The OpenCode event stream was lost and could not reconnect.");
          }
          live.streamFailure = undefined;
          const done = live.reconnected;
          live.reconnected = yield* Deferred.make<void>();
          yield* Deferred.succeed(done, undefined);
          return yield* follow(next.value);
        }),
      ),
    );

  return {
    failAll,
    backfill,
    reconcile,
    reconnect,
    follow,
  };
};

export type Lifecycle = ReturnType<typeof makeLifecycle>;
