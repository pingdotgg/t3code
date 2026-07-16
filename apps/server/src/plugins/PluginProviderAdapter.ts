/**
 * Adapts a plugin's four-method provider driver into the host's full
 * `ProviderAdapterShape`.
 *
 * This shim is the whole reason plugin providers are safe to allow. The host adapter
 * contract has 13 members, most of which are about ROUTING and IDENTITY rather than
 * about talking to a model — session bookkeeping, event stamping, snapshots. Handing
 * those to plugin JS would mean trusting a plugin with state the host needs to be
 * correct, and freezing 13 failure contracts as a public API. So a plugin implements
 * four methods and the host implements the rest, here, once.
 *
 * @module plugins/PluginProviderAdapter
 */
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
  EventId,
} from "@t3tools/contracts";
import type { PluginProviderDriver, PluginProviderEvent } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";

/** A plugin call that hangs must not wedge the user's turn forever. */
const PLUGIN_CALL_TIMEOUT = Duration.minutes(10);
/** Lifecycle calls are not model calls; they should be quick. */
const PLUGIN_LIFECYCLE_TIMEOUT = Duration.seconds(30);

export class PluginProviderError extends Error {
  readonly _tag = "PluginProviderError";
}

interface SessionState {
  readonly session: ProviderSession;
  /** Live while a turn is running; interrupted on stop/interrupt/removal. */
  readonly turnFiber: Fiber.Fiber<void, never> | null;
  readonly activeTurnId: TurnId | null;
}

export const makePluginProviderAdapter = (input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: string;
  readonly driver: PluginProviderDriver;
  /** Already decoded against the descriptor's configSchema. */
  readonly config: unknown;
  readonly now: () => string;
  readonly nextEventId: () => string;
}) =>
  Effect.gen(function* () {
    // HOST-OWNED session bookkeeping. The host needs this to route; a plugin that
    // lied about its sessions (or just lost track) would break routing for everyone.
    const sessions = yield* Ref.make<ReadonlyMap<ThreadId, SessionState>>(new Map());
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const publish = (event: ProviderRuntimeEvent) => Queue.offer(events, event);

    /**
     * Stamp a plugin's payload into a real runtime event.
     *
     * The plugin supplies TEXT. The host supplies identity: eventId, provider kind,
     * threadId, turnId, timestamp. A plugin that could stamp its own could attribute
     * output to another provider's thread.
     */
    const stampDelta = (threadId: ThreadId, turnId: TurnId, text: string): ProviderRuntimeEvent =>
      ({
        type: "content.delta",
        eventId: EventId.make(input.nextEventId()),
        provider: input.driverKind,
        threadId,
        turnId,
        createdAt: input.now(),
        payload: { streamKind: "assistant_text", delta: text },
      }) as ProviderRuntimeEvent;

    /**
     * The turn's single terminal, emitted by the HOST from sendTurn's outcome.
     *
     * The plugin has no "turn finished" event to emit, so there is exactly one
     * completion signal and nothing to race. A failure keeps whatever text already
     * streamed and marks the turn failed — discarding output the user watched arrive
     * would be worse than showing it next to an error.
     */
    const stampTurnStarted = (threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent =>
      ({
        type: "turn.started",
        eventId: EventId.make(input.nextEventId()),
        provider: input.driverKind,
        threadId,
        turnId,
        createdAt: input.now(),
        payload: {},
      }) as ProviderRuntimeEvent;

    const stampTurnCompleted = (
      threadId: ThreadId,
      turnId: TurnId,
      errorMessage?: string,
    ): ProviderRuntimeEvent =>
      ({
        type: "turn.completed",
        eventId: EventId.make(input.nextEventId()),
        provider: input.driverKind,
        threadId,
        turnId,
        createdAt: input.now(),
        payload:
          errorMessage === undefined ? { state: "completed" } : { state: "failed", errorMessage },
      }) as ProviderRuntimeEvent;

    /**
     * An `emit` closed over ONE session's identity, and over the window in which it is
     * valid. The plugin cannot address another thread with it, and a late emit (after
     * the turn ended, or after stopSession) is dropped and logged rather than
     * producing output nobody expects.
     */
    const makeEmit = (threadId: ThreadId) => (event: PluginProviderEvent) => {
      Effect.runSync(
        Effect.gen(function* () {
          const state = (yield* Ref.get(sessions)).get(threadId);
          if (state === undefined || state.activeTurnId === null) {
            yield* Effect.logDebug("plugin provider emitted outside a turn; dropping", {
              driverKind: input.driverKind,
              threadId,
            });
            return;
          }
          if (event.type === "assistant-delta" && event.text !== "") {
            yield* publish(stampDelta(threadId, state.activeTurnId, event.text));
          }
        }),
      );
    };

    const startSession: ProviderAdapterShape<PluginProviderError>["startSession"] = (
      startInput: ProviderSessionStartInput,
    ) =>
      Effect.gen(function* () {
        const threadId = startInput.threadId;
        yield* input.driver
          .startSession({ threadId, config: input.config, emit: makeEmit(threadId) })
          .pipe(
            Effect.timeoutOrElse({
              duration: PLUGIN_LIFECYCLE_TIMEOUT,
              orElse: () => Effect.fail(new PluginProviderError("startSession timed out")),
            }),
            Effect.mapError((cause) => new PluginProviderError(String(cause))),
          );

        const session: ProviderSession = {
          provider: input.driverKind,
          status: "ready",
          runtimeMode: startInput.runtimeMode,
          threadId,
        } as ProviderSession;
        yield* Ref.update(sessions, (current) =>
          new Map(current).set(threadId, { session, turnFiber: null, activeTurnId: null }),
        );
        return session;
      });

    const endTurn = (threadId: ThreadId, turnId: TurnId) =>
      Ref.update(sessions, (current) => {
        const state = current.get(threadId);
        if (state === undefined) return current;
        // Only clear if this turn is still the active one. A stale fiber's
        // `ensuring(endTurn)` — a turn that was interrupted or superseded — must
        // not null out a successor turn's fiber/id after the successor took over.
        if (state.activeTurnId !== turnId) return current;
        return new Map(current).set(threadId, { ...state, turnFiber: null, activeTurnId: null });
      });

    const sendTurn: ProviderAdapterShape<PluginProviderError>["sendTurn"] = (
      turnInput: ProviderSendTurnInput,
    ) =>
      Effect.gen(function* () {
        const threadId = turnInput.threadId;
        const state = (yield* Ref.get(sessions)).get(threadId);
        if (state === undefined) {
          return yield* Effect.fail(new PluginProviderError("no session for thread"));
        }
        // One active turn per thread. Overwriting activeTurnId/turnFiber here would
        // orphan the in-progress turn's fiber (losing the handle interrupt/stop rely
        // on) and its `ensuring(endTurn)` would later null the successor's state,
        // dropping the second turn's deltas. Upstream does not serialize per thread
        // (its reactor forks), so the host enforces the invariant by rejecting: the
        // engine treats a failed dispatch as a rejection, which preserves the
        // running turn rather than silently interrupting it.
        if (state.activeTurnId !== null || state.turnFiber !== null) {
          return yield* Effect.fail(
            new PluginProviderError("a turn is already active for this thread"),
          );
        }
        // Host-stamped: the plugin correlates against this, it never invents one.
        const turnId = input.nextEventId() as TurnId;

        yield* publish(stampTurnStarted(threadId, turnId));
        // Record the active turn BEFORE forking. The child starts immediately, so a
        // driver that emits its first delta synchronously would otherwise arrive
        // while activeTurnId is still null — and `makeEmit` would drop the very first
        // thing the plugin said. (The probe that fixed the interrupt bug exposed this
        // one underneath it.)
        yield* Ref.update(sessions, (current) => {
          const existing = current.get(threadId);
          if (existing === undefined) return current;
          return new Map(current).set(threadId, { ...existing, activeTurnId: turnId });
        });
        // The turn is over when sendTurn returns or fails — there is no completion
        // event to race with. Run it in a fiber so interrupt/removal can cancel it.
        // startImmediately: WITHOUT it the child does not begin until the next yield,
        // so the plugin's sendTurn has not started when this returns — an interrupt
        // arriving straight after would cancel a turn the driver never began, and
        // early deltas would have nowhere to go. (A probe caught this: the interrupt
        // test failed because there was nothing running to interrupt.)
        const fiber = yield* Effect.forkChild(
          input.driver.sendTurn({ threadId, turnId, prompt: turnInput.input ?? "" }).pipe(
            Effect.timeoutOrElse({
              duration: PLUGIN_CALL_TIMEOUT,
              orElse: () => Effect.fail(new PluginProviderError("sendTurn timed out")),
            }),
            // A plugin failure becomes a provider error the thread can show. It
            // never propagates as a host defect: partial text the user already
            // watched arrive is kept, and the turn is marked failed.
            Effect.matchCauseEffect({
              onSuccess: () => publish(stampTurnCompleted(threadId, turnId)),
              onFailure: (cause) =>
                publish(stampTurnCompleted(threadId, turnId, Cause.pretty(cause))),
            }),
            Effect.asVoid,
            Effect.ensuring(endTurn(threadId, turnId)),
          ),
          { startImmediately: true },
        );

        yield* Ref.update(sessions, (current) => {
          const existing = current.get(threadId);
          if (existing === undefined) return current;
          return new Map(current).set(threadId, {
            ...existing,
            turnFiber: fiber as Fiber.Fiber<void, never>,
            activeTurnId: turnId,
          });
        });

        return { threadId, turnId } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ProviderAdapterShape<PluginProviderError>["interruptTurn"] = (
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const state = (yield* Ref.get(sessions)).get(threadId);
        if (state?.activeTurnId !== null && state?.activeTurnId !== undefined) {
          // Ask the plugin first, but do not depend on it: the host ends the turn
          // either way, so a driver that ignores interrupts cannot leave one running.
          if (input.driver.interruptTurn !== undefined) {
            yield* input.driver.interruptTurn({ threadId, turnId: state.activeTurnId }).pipe(
              Effect.timeoutOrElse({
                duration: PLUGIN_LIFECYCLE_TIMEOUT,
                orElse: () => Effect.void,
              }),
              Effect.catchCause(() => Effect.void),
            );
          }
        }
        if (state?.turnFiber) yield* Fiber.interrupt(state.turnFiber).pipe(Effect.orDie);
        // Clear keyed on the turn we just interrupted. The interrupted fiber's own
        // `ensuring(endTurn)` already ran with the same turnId, so this is a
        // no-op-safe backstop for the fiber-less case rather than a blind clear.
        if (state?.activeTurnId != null) yield* endTurn(threadId, state.activeTurnId);
      });

    const stopSession: ProviderAdapterShape<PluginProviderError>["stopSession"] = (
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const state = (yield* Ref.get(sessions)).get(threadId);
        if (state?.turnFiber) yield* Fiber.interrupt(state.turnFiber).pipe(Effect.orDie);
        yield* input.driver.stopSession(threadId).pipe(
          Effect.timeoutOrElse({
            duration: PLUGIN_LIFECYCLE_TIMEOUT,
            orElse: () => Effect.void,
          }),
          // Stopping must succeed from the host's point of view even if the plugin
          // cannot: the alternative is a session the host can never clean up.
          Effect.catchCause((cause) =>
            Effect.logWarning("plugin provider stopSession failed; dropping session anyway", {
              driverKind: input.driverKind,
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* Ref.update(sessions, (current) => {
          const next = new Map(current);
          next.delete(threadId);
          return next;
        });
      });

    const unsupported = (member: string) =>
      Effect.fail(
        new PluginProviderError(
          `plugin providers do not support ${member} (this host's v1 plugin provider surface streams text only)`,
        ),
      );

    const adapter: ProviderAdapterShape<PluginProviderError> = {
      provider: input.driverKind,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      stopSession,
      listSessions: () =>
        Ref.get(sessions).pipe(Effect.map((map) => [...map.values()].map((s) => s.session))),
      hasSession: (threadId) => Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId))),
      // Provider-side history semantics. A plugin faking these would corrupt
      // checkpointing, so they fail typed rather than lying.
      readThread: () => unsupported("readThread"),
      rollbackThread: () => unsupported("rollbackThread"),
      // Only reachable if a plugin provider could RAISE an approval — the v1 event
      // union cannot, so these are unreachable rather than merely unimplemented.
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ) => unsupported("respondToRequest"),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ) => unsupported("respondToUserInput"),
      stopAll: () =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => Effect.forEach([...map.keys()], stopSession)),
          Effect.asVoid,
        ),
      streamEvents: Stream.fromQueue(events),
    };

    return adapter;
  });
