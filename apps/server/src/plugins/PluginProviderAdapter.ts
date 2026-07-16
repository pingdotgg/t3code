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
  /**
   * Set once stopSession begins tearing the session down. hasSession stays true
   * until the final delete, so a turn racing in during the driver's stopSession
   * await must be rejected rather than installing a fiber the delete then orphans.
   */
  readonly stopping: boolean;
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
    // Shut the queue down when the adapter's scope closes (provider instance removed
    // or reconfigured). Without this, `Stream.fromQueue(events)` never terminates and
    // any downstream subscriber fiber blocks forever — one orphaned fiber leaked per
    // removal/reconfiguration.
    yield* Effect.addFinalizer(() => Queue.shutdown(events));

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
        // Effect.suspend so a driver that THROWS synchronously (or returns a
        // non-Effect) from startSession becomes a typed PluginProviderError instead
        // of a defect escaping the adapter. Driver code is dynamically loaded plugin
        // JS, so its return contract is not runtime-enforced.
        yield* Effect.suspend(() =>
          input.driver.startSession({ threadId, config: input.config, emit: makeEmit(threadId) }),
        ).pipe(
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
          new Map(current).set(threadId, {
            session,
            turnFiber: null,
            activeTurnId: null,
            stopping: false,
          }),
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
        // Host-stamped, computed up front so the reservation can install it in the
        // same atomic step it guards on. The plugin correlates against this; it never
        // invents one.
        const turnId = input.nextEventId() as TurnId;

        // ATOMIC turn reservation. The guard AND the install are one Ref.modify, so
        // two concurrent sendTurn fibers for one thread (upstream's reactor forks per
        // turn-start) cannot both slip through a check-then-set gap: whichever modify
        // runs first reserves the turn by setting activeTurnId, and the other observes
        // it and is rejected. The previous read→guard→(yield)→update let both fibers
        // pass the guard on a stale snapshot, both fork drivers, and the later update
        // overwrote activeTurnId/turnFiber — orphaning the earlier fiber's handle
        // (mixing deltas, and leaving interrupt/stop unable to reach it).
        const reservation = yield* Ref.modify(sessions, (current) => {
          const existing = current.get(threadId);
          if (existing === undefined) return ["no-session" as const, current];
          // A turn racing in while stopSession is awaiting the driver's teardown must
          // be rejected: hasSession is still true (the delete comes last), so
          // reserving here would install a fiber the imminent delete then orphans —
          // dropping its deltas and losing the fiber handle.
          if (existing.stopping) return ["stopping" as const, current];
          // One active turn per thread. Reserving over a running turn would orphan its
          // fiber (losing the handle interrupt/stop rely on) and its
          // `ensuring(endTurn)` would later null the successor's state. Upstream does
          // not serialize per thread, so the host enforces the invariant by rejecting:
          // the engine treats a failed dispatch as a rejection, preserving the running
          // turn rather than silently interrupting it.
          if (existing.activeTurnId !== null || existing.turnFiber !== null) {
            return ["busy" as const, current];
          }
          // Reserve by setting activeTurnId BEFORE any fork or yield. The child starts
          // immediately, so a driver that emits its first delta synchronously finds a
          // live activeTurnId in `makeEmit` rather than the null it would drop on.
          return [
            "reserved" as const,
            new Map(current).set(threadId, { ...existing, activeTurnId: turnId }),
          ];
        });

        if (reservation === "no-session") {
          return yield* Effect.fail(new PluginProviderError("no session for thread"));
        }
        if (reservation === "stopping") {
          return yield* Effect.fail(new PluginProviderError("session is stopping"));
        }
        if (reservation === "busy") {
          return yield* Effect.fail(
            new PluginProviderError("a turn is already active for this thread"),
          );
        }

        // The reservation is installed. From here until the turn fiber is running, any
        // failure (or a fork that is never reached) must clear the reservation, or the
        // thread is permanently wedged with a phantom active turn nobody can end.
        // `onError` runs the clear on failure/defect/interruption; endTurn is keyed on
        // turnId, so it only ever clears THIS reservation, never a successor's.
        return yield* Effect.gen(function* () {
          // The publish is an unbounded queue offer (infallible), but it lives inside
          // the guarded region regardless so nothing can leak the reservation.
          yield* publish(stampTurnStarted(threadId, turnId));
          // The turn is over when sendTurn returns or fails — there is no completion
          // event to race with. Run it in a fiber so interrupt/removal can cancel it.
          // startImmediately: WITHOUT it the child does not begin until the next yield,
          // so the plugin's sendTurn has not started when this returns — an interrupt
          // arriving straight after would cancel a turn the driver never began, and
          // early deltas would have nowhere to go. (A probe caught this: the interrupt
          // test failed because there was nothing running to interrupt.)
          const fiber = yield* Effect.forkChild(
            // Effect.suspend so a synchronous throw from the driver's sendTurn is
            // captured as a turn failure (published terminal) rather than a defect.
            Effect.suspend(() =>
              input.driver.sendTurn({ threadId, turnId, prompt: turnInput.input ?? "" }),
            ).pipe(
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
              // On INTERRUPTION (interruptTurn / stopSession / host teardown) the
              // matchCauseEffect above does not publish a terminal, so without this the
              // orchestration session would wait forever on a turn that already ended.
              // Emit the single terminal explicitly on interrupt; a normal completion
              // already published its terminal and short-circuits this. endTurn still
              // runs in the ensuring below on every path.
              Effect.onInterrupt(() =>
                publish(stampTurnCompleted(threadId, turnId, "interrupted")),
              ),
              Effect.ensuring(endTurn(threadId, turnId)),
            ),
            { startImmediately: true },
          );

          // Install the fiber handle, still guarding on our reservation: skip if the
          // session was deleted (absent-session guard, so a concurrent stop/delete is
          // not resurrected) or the reservation was superseded (activeTurnId no longer
          // ours). activeTurnId is already turnId from the reservation.
          const installed = yield* Ref.modify(sessions, (current) => {
            const existing = current.get(threadId);
            // Also refuse to install once stopSession has begun (`stopping`): a turn
            // that reserved before stop started would otherwise install its fiber
            // mid-teardown — stopSession already interrupted whatever fiber it saw
            // (null then), so this one would run untracked to the 10-minute timeout.
            // Not installing here routes it to the interrupt below.
            if (existing === undefined || existing.activeTurnId !== turnId || existing.stopping) {
              return [false as const, current];
            }
            return [
              true as const,
              new Map(current).set(threadId, {
                ...existing,
                turnFiber: fiber as Fiber.Fiber<void, never>,
                activeTurnId: turnId,
              }),
            ];
          });

          // The reservation set activeTurnId BEFORE the fork, but the fiber handle is
          // stored only here — so there is a window where the turn is active with no
          // stored fiber. If interruptTurn (or a stop/delete) ran in that window it
          // cleared/superseded our reservation, and this install just no-op'd. The
          // fiber we forked is therefore UNTRACKED: nothing holds its handle, so
          // interrupt/stop can never reach it and it would run on as a phantom turn the
          // caller believes was cancelled. Interrupt it here to close that race.
          if (!installed) {
            yield* Fiber.interrupt(fiber).pipe(Effect.orDie);
          }

          return { threadId, turnId } satisfies ProviderTurnStartResult;
        }).pipe(Effect.onError(() => endTurn(threadId, turnId)));
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
            const interrupt = input.driver.interruptTurn;
            // Effect.suspend so a synchronously-throwing driver interruptTurn is
            // captured by the catchCause below instead of escaping the adapter.
            yield* Effect.suspend(() => interrupt({ threadId, turnId: state.activeTurnId! })).pipe(
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
        // Mark the session stopping BEFORE anything awaits, so a sendTurn racing in
        // during the driver's stopSession await below is rejected rather than
        // installing a fiber the final delete would orphan. Interrupting the turn
        // fiber runs its `ensuring(endTurn)`, which spreads ...state and so preserves
        // this flag. No-op if the session is already gone.
        yield* Ref.update(sessions, (current) => {
          const existing = current.get(threadId);
          if (existing === undefined) return current;
          return new Map(current).set(threadId, { ...existing, stopping: true });
        });
        const state = (yield* Ref.get(sessions)).get(threadId);
        if (state?.turnFiber) yield* Fiber.interrupt(state.turnFiber).pipe(Effect.orDie);
        // Effect.suspend so a synchronously-throwing driver stopSession is captured
        // rather than escaping, and Effect.ensuring so the session is ALWAYS deleted
        // from the map — otherwise a throw/interrupt would leave the session pinned
        // `stopping: true`, permanently un-cleanable and rejecting every future turn.
        yield* Effect.suspend(() => input.driver.stopSession(threadId)).pipe(
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
          Effect.ensuring(
            Ref.update(sessions, (current) => {
              const next = new Map(current);
              next.delete(threadId);
              return next;
            }),
          ),
        );
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
