/**
 * Autonomous (out-of-prompt) ACP turn synthesis.
 *
 * ACP-hosted agents (kimi, grok) can start working on their own — for example
 * when a background subagent completes and the agent resumes without a client
 * `session/prompt` in flight. The session events it streams then arrive while
 * `ctx.activeTurnId` is undefined. Instead of dropping them, the adapters
 * synthesize a turn:
 *
 * - OPEN: a content-bearing session event arrives with no active turn and no
 *   prompt in flight. The adapter mints a turn id, marks the session running,
 *   and emits `turn.started` before forwarding the event under that id.
 * - RE-ARM: every forwarded event re-arms a quiescence timer (event-sequence
 *   based; see `rearmAutonomousTurnClose`).
 * - CLOSE: with no prompt RPC there is no stopReason, so the turn closes once
 *   the event stream has been quiet for `ACP_AUTONOMOUS_TURN_IDLE_TIMEOUT`.
 *   The close emits `turn.completed` (state "completed") and returns the
 *   session to ready. A `sendTurn` or `interruptTurn` closes the synthesized
 *   turn first so prompt-driven turns start cleanly.
 *
 * Synthesis is suppressed briefly after `interruptTurn`
 * (`ACP_AUTONOMOUS_TURN_INTERRUPT_SUPPRESSION_MILLIS`) so cancel-tail flush
 * from the agent is still dropped instead of resurrecting as a new turn.
 *
 * The notification fiber never takes the thread lock: prompt settlement waits
 * on the drain barrier acknowledged by that fiber, so locking here would
 * deadlock. Synthesis relies on an atomic check-and-set (no async boundary
 * between re-check and mutation); the quiescence close and the sendTurn close
 * DO take the thread lock, which is safe because they never wait on the
 * notification fiber.
 */
import {
  type EventId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** Idle gap after the last autonomous session event before the synthesized turn closes. */
export const ACP_AUTONOMOUS_TURN_IDLE_TIMEOUT = "2 seconds" as const;

/**
 * Window after an interrupt during which out-of-prompt events are treated as
 * cancel-tail flush and dropped, never as the start of an autonomous turn.
 */
export const ACP_AUTONOMOUS_TURN_INTERRUPT_SUPPRESSION_MILLIS = 2_000;

/**
 * Structural view of an ACP adapter session context. Both ACP adapters keep
 * these fields; the helper only touches the autonomous-turn subset.
 */
export interface AcpAutonomousTurnContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  /** Set iff `activeTurnId` was synthesized for out-of-prompt agent activity. */
  autonomousTurnId: TurnId | undefined;
  promptsInFlight: number;
  interruptedTurnIds: Set<TurnId>;
  /** Wall-clock millis of the latest interruptTurn; gates synthesis. */
  lastTurnInterruptedAtMs: number | undefined;
  /** Monotonic count of ACP events processed by the notification fiber. */
  eventSequence: number;
  stopped: boolean;
}

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface AcpAutonomousTurnDeps<E = never, R = never> {
  readonly provider: ProviderDriverKind;
  readonly mintTurnId: Effect.Effect<TurnId, E, R>;
  readonly makeEventStamp: () => Effect.Effect<AcpEventStamp, E, R>;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void, E, R>;
  readonly withThreadLock: <A, E2, R2>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
  readonly nowMillis: Effect.Effect<number, E, R>;
  readonly nowIso: Effect.Effect<string, E, R>;
}

const autonomousTurnIsOpen = (ctx: AcpAutonomousTurnContext, turnId: TurnId): boolean =>
  !ctx.stopped &&
  ctx.autonomousTurnId === turnId &&
  ctx.activeTurnId === turnId &&
  !ctx.interruptedTurnIds.has(turnId);

const completeAutonomousTurn = <E, R>(
  deps: AcpAutonomousTurnDeps<E, R>,
  ctx: AcpAutonomousTurnContext,
  turnId: TurnId,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const stamp = yield* deps.makeEventStamp();
    const updatedAt = yield* deps.nowIso;
    ctx.autonomousTurnId = undefined;
    ctx.activeTurnId = undefined;
    const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
    ctx.session = {
      ...readySession,
      status: "ready",
      updatedAt,
    };
    yield* deps.publish({
      type: "turn.completed",
      ...stamp,
      provider: deps.provider,
      threadId: ctx.threadId,
      turnId,
      payload: {
        state: "completed",
        stopReason: "end_turn",
      },
    });
  });

const closeAutonomousTurnIfQuiet = <E, R>(
  deps: AcpAutonomousTurnDeps<E, R>,
  ctx: AcpAutonomousTurnContext,
  turnId: TurnId,
  armedAtEventSequence: number,
): Effect.Effect<void, E, R> =>
  deps.withThreadLock(
    ctx.threadId,
    Effect.gen(function* () {
      if (!autonomousTurnIsOpen(ctx, turnId)) {
        return;
      }
      if (ctx.promptsInFlight > 0) {
        return;
      }
      // A newer event re-armed the close; this timer is stale.
      if (ctx.eventSequence !== armedAtEventSequence) {
        return;
      }
      yield* completeAutonomousTurn(deps, ctx, turnId);
    }),
  );

/**
 * (Re)arm the quiescence close for the open synthesized turn. Call after every
 * forwarded event: each arm captures the current event sequence, so a timer
 * only closes the turn when the stream stayed quiet for the whole window.
 * Forked into the session scope so teardown kills pending timers.
 */
export const rearmAutonomousTurnClose = <E, R>(
  deps: AcpAutonomousTurnDeps<E, R>,
  ctx: AcpAutonomousTurnContext,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const turnId = ctx.autonomousTurnId;
    if (turnId === undefined || !autonomousTurnIsOpen(ctx, turnId)) {
      return;
    }
    const armedAtEventSequence = ctx.eventSequence;
    yield* Effect.sleep(ACP_AUTONOMOUS_TURN_IDLE_TIMEOUT).pipe(
      Effect.andThen(closeAutonomousTurnIfQuiet(deps, ctx, turnId, armedAtEventSequence)),
      Effect.forkIn(ctx.scope),
    );
  });

/**
 * Resolve the turn id a session notification should be forwarded under,
 * synthesizing an autonomous turn when content arrives with no active turn
 * and no prompt in flight. Returns undefined when the event must be dropped
 * (session stopped, prompt in flight without a bound turn yet, or inside the
 * post-interrupt suppression window).
 *
 * `allowSynthesis` should be false for events that are not turn-opening
 * content on their own — e.g. a bare `AssistantItemCompleted`, which the ACP
 * runtime also emits as segment cleanup when an interrupted prompt fiber
 * settles. Opening a turn for those would synthesize empty zombie turns.
 */
export const resolveAutonomousNotificationTurnId = <E, R>(
  deps: AcpAutonomousTurnDeps<E, R>,
  ctx: AcpAutonomousTurnContext,
  options?: { readonly allowSynthesis?: boolean },
): Effect.Effect<TurnId | undefined, E, R> =>
  Effect.gen(function* () {
    if (ctx.activeTurnId !== undefined || ctx.stopped || ctx.promptsInFlight > 0) {
      return ctx.activeTurnId;
    }
    if (options?.allowSynthesis === false) {
      return undefined;
    }
    const nowMs = yield* deps.nowMillis;
    if (
      ctx.lastTurnInterruptedAtMs !== undefined &&
      nowMs - ctx.lastTurnInterruptedAtMs < ACP_AUTONOMOUS_TURN_INTERRUPT_SUPPRESSION_MILLIS
    ) {
      return undefined;
    }
    const turnId = yield* deps.mintTurnId;
    const stamp = yield* deps.makeEventStamp();
    const updatedAt = yield* deps.nowIso;
    // Atomic check-and-set: no async boundary between this re-check and the
    // mutation below, so a concurrent sendTurn/interruptTurn (which need the
    // thread lock and can only run at async boundaries) cannot interleave.
    if (ctx.activeTurnId !== undefined || ctx.promptsInFlight > 0 || ctx.stopped) {
      return ctx.activeTurnId;
    }
    ctx.activeTurnId = turnId;
    ctx.autonomousTurnId = turnId;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };
    yield* deps.publish({
      type: "turn.started",
      ...stamp,
      provider: deps.provider,
      threadId: ctx.threadId,
      turnId,
      payload: ctx.session.model !== undefined ? { model: ctx.session.model } : {},
    });
    // Re-read: a queued sendTurn may have closed the synthesized turn already.
    return ctx.activeTurnId;
  });

/**
 * Close the open synthesized turn (if any) so a new sendTurn starts cleanly.
 * Runs inside sendTurn's thread-lock section.
 */
export const closeAutonomousTurnBeforePrompt = <E, R>(
  deps: AcpAutonomousTurnDeps<E, R>,
  ctx: AcpAutonomousTurnContext,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const turnId = ctx.autonomousTurnId;
    if (turnId === undefined) {
      return;
    }
    if (!autonomousTurnIsOpen(ctx, turnId) || ctx.promptsInFlight > 0) {
      // State drifted (e.g. interrupt marked the turn but has not settled yet);
      // never emit a completion from here — just drop the marker defensively.
      ctx.autonomousTurnId = undefined;
      return;
    }
    yield* completeAutonomousTurn(deps, ctx, turnId);
  });

/**
 * Clear the synthesized-turn marker when an external settlement (interrupt)
 * already emitted the turn's terminal event. Synchronous by design: callers
 * use it inside lock sections without adding async boundaries.
 */
export const clearAutonomousTurnIfMatches = (
  ctx: AcpAutonomousTurnContext,
  turnId: TurnId | undefined,
): void => {
  if (turnId !== undefined && ctx.autonomousTurnId === turnId) {
    ctx.autonomousTurnId = undefined;
  }
};
