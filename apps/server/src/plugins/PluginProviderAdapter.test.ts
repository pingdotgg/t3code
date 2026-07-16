import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import type { PluginProviderDriver, PluginProviderEvent } from "@t3tools/plugin-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makePluginProviderAdapter } from "./PluginProviderAdapter.ts";

const driverKind = ProviderDriverKind.make("acme");
const threadId = ThreadId.make("thread-acme");

class DriverExploded extends Error {
  readonly _tag = "DriverExploded";
}

const adapterFor = (driver: PluginProviderDriver) =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    return yield* makePluginProviderAdapter({
      driverKind,
      instanceId: "acme_default",
      driver,
      config: { apiBase: "https://acme.test" },
      now: () => "2026-01-01T00:00:00.000Z",
      nextEventId: () => `evt-${Effect.runSync(Ref.updateAndGet(counter, (n) => n + 1))}`,
    });
  });

const start = (
  adapter: Awaited<ReturnType<typeof adapterFor>> extends Effect.Effect<infer A> ? A : never,
) => adapter.startSession({ threadId, runtimeMode: "full-access" } as never);

/** Collect events emitted while `body` runs. */
const collecting = <A, E>(
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  body: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const pump = yield* Effect.forkChild(
      adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
      ),
    );
    const result = yield* body;
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(pump).pipe(Effect.orDie);
    return { result, events: yield* Ref.get(seen) };
  });

describe("makePluginProviderAdapter", () => {
  it.effect("streams a plugin's deltas as host-stamped assistant text", () =>
    Effect.gen(function* () {
      let emitter: ((event: PluginProviderEvent) => void) | null = null;
      const adapter = yield* adapterFor({
        startSession: (input) =>
          Effect.sync(() => {
            emitter = input.emit;
          }),
        sendTurn: () => Effect.sync(() => emitter?.({ type: "assistant-delta", text: "hello" })),
        stopSession: () => Effect.void,
      });

      const { events } = yield* collecting(
        adapter,
        Effect.gen(function* () {
          yield* start(adapter);
          yield* adapter.sendTurn({ threadId, input: "hi" } as never);
          yield* Effect.yieldNow;
        }),
      );

      const delta = events.find((event) => event.type === "content.delta");
      assert.isDefined(delta, "the plugin's text must reach the thread");
      // The HOST stamps identity. A plugin that could set these could attribute output
      // to another provider's thread.
      assert.strictEqual(delta?.provider, driverKind);
      assert.strictEqual(delta?.threadId, threadId);
      assert.isDefined(delta?.eventId);
    }),
  );

  it.effect("emits exactly one terminal, from sendTurn's return", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        sendTurn: () => Effect.void,
        stopSession: () => Effect.void,
      });

      const { events } = yield* collecting(
        adapter,
        Effect.gen(function* () {
          yield* start(adapter);
          yield* adapter.sendTurn({ threadId, input: "hi" } as never);
          yield* Effect.yieldNow;
        }),
      );

      // The plugin has no way to signal completion, so there is exactly one — nothing
      // to race, and no way to end up waiting for an event that already happened
      // another way.
      const terminals = events.filter((event) => event.type === "turn.completed");
      assert.strictEqual(terminals.length, 1);
    }),
  );

  it.effect("turns a plugin failure into a failed turn, not a host crash", () =>
    Effect.gen(function* () {
      let emitter: ((event: PluginProviderEvent) => void) | null = null;
      const adapter = yield* adapterFor({
        startSession: (input) =>
          Effect.sync(() => {
            emitter = input.emit;
          }),
        sendTurn: () =>
          Effect.sync(() => emitter?.({ type: "assistant-delta", text: "partial" })).pipe(
            Effect.flatMap(() => Effect.fail(new DriverExploded("boom"))),
          ),
        stopSession: () => Effect.void,
      });

      const { events } = yield* collecting(
        adapter,
        Effect.gen(function* () {
          yield* start(adapter);
          yield* adapter.sendTurn({ threadId, input: "hi" } as never);
          yield* Effect.yieldNow;
        }),
      );

      // The text the user already watched arrive is KEPT...
      assert.isDefined(events.find((event) => event.type === "content.delta"));
      // ...next to a failed terminal, rather than the turn vanishing or the host dying.
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.strictEqual(
        terminal?.type === "turn.completed" ? terminal.payload.state : null,
        "failed",
      );
    }),
  );

  it.effect("drops an emit that arrives outside a turn", () =>
    Effect.gen(function* () {
      let emitter: ((event: PluginProviderEvent) => void) | null = null;
      const adapter = yield* adapterFor({
        startSession: (input) =>
          Effect.sync(() => {
            emitter = input.emit;
          }),
        sendTurn: () => Effect.void,
        stopSession: () => Effect.void,
      });

      const { events } = yield* collecting(
        adapter,
        Effect.gen(function* () {
          yield* start(adapter);
          // No turn is running: a late or stray emit must not manufacture output.
          emitter?.({ type: "assistant-delta", text: "should not appear" });
          yield* Effect.yieldNow;
        }),
      );

      assert.isUndefined(events.find((event) => event.type === "content.delta"));
    }),
  );

  it.effect("cancels the in-flight turn when the plugin ignores the interrupt", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const interrupted = yield* Ref.make(false);
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        // Never returns on its own — an uncooperative driver. The flag is set only if
        // the HOST cancels the fiber out from under it.
        sendTurn: () =>
          Deferred.await(released).pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
        stopSession: () => Effect.void,
        // Deliberately no interruptTurn: the host must cope alone.
      });

      yield* start(adapter);
      yield* adapter.sendTurn({ threadId, input: "hi" } as never);
      yield* adapter.interruptTurn(threadId);
      yield* Effect.yieldNow;

      // Asserting hasSession here proved nothing — it is true either way, which is how
      // the first version of this test passed with the cancellation deleted. Observing
      // the interruption is the only thing that shows the host actually ended the turn
      // rather than leaving a driver running forever.
      assert.isTrue(yield* Ref.get(interrupted), "the host must cancel the in-flight fiber");
      yield* Deferred.succeed(released, undefined);
    }),
  );

  it.effect(
    "rejects a second turn while one is already active, keeping the first turn's deltas",
    () =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        let emitter: ((event: PluginProviderEvent) => void) | null = null;
        const adapter = yield* adapterFor({
          startSession: (input) =>
            Effect.sync(() => {
              emitter = input.emit;
            }),
          // The first turn emits a delta, then blocks until released — so it is
          // still the single active turn when the second turn is attempted.
          sendTurn: () =>
            Effect.sync(() => emitter?.({ type: "assistant-delta", text: "first" })).pipe(
              Effect.flatMap(() => Deferred.await(released)),
            ),
          stopSession: () => Effect.void,
        });

        const { result, events } = yield* collecting(
          adapter,
          Effect.gen(function* () {
            yield* start(adapter);
            yield* adapter.sendTurn({ threadId, input: "first" } as never);
            // Let the forked first turn emit its delta and park on the deferred.
            yield* Effect.yieldNow;
            // A second turn on the SAME thread while one is active must be rejected,
            // not clobber the active turn's state (which would orphan the first
            // fiber and silently drop its remaining deltas).
            const secondExit = yield* Effect.exit(
              adapter.sendTurn({ threadId, input: "second" } as never),
            );
            yield* Deferred.succeed(released, undefined);
            yield* Effect.yieldNow;
            return secondExit;
          }),
        );

        assert.strictEqual(result._tag, "Failure", "the second turn must fail while one is active");
        assert.isTrue(
          String(result._tag === "Failure" ? result.cause : "").includes("already active"),
          "the rejection must name the single-active-turn invariant",
        );
        // The first turn's state survived the rejected second turn: its delta still
        // reached the thread.
        assert.isDefined(
          events.find((event) => event.type === "content.delta"),
          "the first turn's deltas must still flow after the second is rejected",
        );
      }),
  );

  it.effect(
    "reserves the turn atomically: two concurrent sends yield exactly one active turn",
    () =>
      // What this pins: two concurrent same-thread dispatches resolve to exactly one
      // active turn — one winner, one "already active" rejection, one driver fiber,
      // the winner's deltas flowing, its turnFiber interruptible. That is the atomic
      // reservation's guarantee, and it holds regardless of how the two fibers
      // interleave.
      // What it does NOT pin: it cannot force the old check-then-set to lose. The only
      // yield in that window was `yield* publish`, and Queue.offer on an unbounded
      // queue never suspends — so in a minimal two-fiber test the first caller runs
      // sendTurn to completion before the second starts, and even the buggy version
      // passes here. The window only opened under the runtime's periodic forced yield
      // (2048-op budget), a real production risk; forcing it via MaxOpsBeforeYield=1
      // deadlocks makeEmit's internal Effect.runSync, so it isn't unit-reproducible.
      // The atomic Ref.modify removes the window by construction rather than narrowing
      // it, which is why this stands as an invariant test.
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>(); // parks the winning driver
        const keepAlive = yield* Deferred.make<void>(); // keeps both caller fibers alive
        const exitA = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        const exitB = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        const interrupted = yield* Ref.make(false);
        const driverCalls = yield* Ref.make(0);
        let emitter: ((event: PluginProviderEvent) => void) | null = null;
        const adapter = yield* adapterFor({
          startSession: (input) =>
            Effect.sync(() => {
              emitter = input.emit;
            }),
          // The winning turn emits a delta then parks until released — so it stays the
          // single active turn while the loser's reservation is attempted. The call
          // counter and onInterrupt let the test observe that exactly one driver turn
          // was ever forked, and that its turnFiber is a real, reachable handle (not
          // one lost to a racing overwrite).
          sendTurn: () =>
            Ref.update(driverCalls, (n) => n + 1).pipe(
              Effect.flatMap(() =>
                Effect.sync(() => emitter?.({ type: "assistant-delta", text: "winner" })),
              ),
              Effect.flatMap(() =>
                Deferred.await(released).pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
              ),
            ),
          stopSession: () => Effect.void,
        });

        // Each caller fiber records its sendTurn exit, then PARKS on keepAlive. It must
        // outlive the reservation: sendTurn forks the driver as a child of the caller,
        // so a caller that terminated would reap the driver and its `ensuring(endTurn)`
        // would clear the reservation — exactly how the reactor keeps a turn fiber
        // alive in production. Firing two such callers at ONE thread models the
        // concurrent dispatch the reactor produces when it forks per turn-start.
        const caller = (label: string, slot: Deferred.Deferred<Exit.Exit<unknown, unknown>>) =>
          Effect.exit(adapter.sendTurn({ threadId, input: label } as never)).pipe(
            Effect.flatMap((exit) => Deferred.succeed(slot, exit)),
            Effect.flatMap(() => Deferred.await(keepAlive)),
          );

        const { result: exits, events } = yield* collecting(
          adapter,
          Effect.gen(function* () {
            yield* start(adapter);
            const fiberA = yield* Effect.forkChild(caller("a", exitA));
            const fiberB = yield* Effect.forkChild(caller("b", exitB));
            const ea = yield* Deferred.await(exitA);
            const eb = yield* Deferred.await(exitB);
            // Prove the installed turnFiber is real and reachable BEFORE tearing down:
            // interrupting the turn must cancel the parked driver fiber.
            yield* adapter.interruptTurn(threadId);
            yield* Effect.yieldNow;
            yield* Deferred.succeed(released, undefined);
            yield* Deferred.succeed(keepAlive, undefined);
            yield* Fiber.join(fiberA);
            yield* Fiber.join(fiberB);
            return [ea, eb] as const;
          }),
        );

        const successes = exits.filter((exit) => exit._tag === "Success");
        const failures = exits.filter((exit) => exit._tag === "Failure");
        assert.strictEqual(
          successes.length,
          1,
          "exactly one concurrent turn may win the reservation",
        );
        assert.strictEqual(failures.length, 1, "the other concurrent turn must be rejected");
        assert.isTrue(
          String(failures[0]?._tag === "Failure" ? failures[0].cause : "").includes(
            "already active",
          ),
          "the loser must fail with the single-active-turn message",
        );
        // Only the winner reached the driver: the loser was rejected AT the atomic
        // reservation, before any fiber was forked. One driver call ⇒ one turnFiber.
        assert.strictEqual(
          yield* Ref.get(driverCalls),
          1,
          "exactly one turn fiber was ever started",
        );
        // The winner's delta reached the thread.
        assert.isDefined(
          events.find((event) => event.type === "content.delta"),
          "the winner's deltas must flow",
        );
        // The winner's turnFiber was reachable: the interrupt cancelled its driver.
        // Under the old check-then-set the loser could overwrite the winner's handle,
        // and this interrupt would reach nothing.
        assert.isTrue(
          yield* Ref.get(interrupted),
          "the winner's turnFiber must be interruptible after the race",
        );
      }),
  );

  it.effect("rejects a turn that races in while stopSession is tearing the session down", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        // The first turn parks so it is the single active turn when stop begins.
        sendTurn: () => Effect.never,
        // stopSession blocks mid-teardown: it signals it has entered, then waits.
        // A concurrent sendTurn arriving in this window used to pass the null-state
        // guard, install a fresh fiber, and be orphaned by the final delete.
        stopSession: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(releaseStop)),
          ),
      });

      yield* start(adapter);
      yield* adapter.sendTurn({ threadId, input: "first" } as never);
      yield* Effect.yieldNow;

      const stopFiber = yield* Effect.forkChild(adapter.stopSession(threadId));
      // Wait until the driver's stopSession is parked mid-teardown.
      yield* Deferred.await(entered);

      // A turn racing in now — after stopping was set, before the delete — must be
      // rejected rather than orphaned by the imminent delete.
      const raced = yield* Effect.exit(adapter.sendTurn({ threadId, input: "racer" } as never));
      assert.strictEqual(raced._tag, "Failure", "a turn racing a stopping session must fail");
      assert.isTrue(
        String(raced._tag === "Failure" ? raced.cause : "").includes("session is stopping"),
        "the rejection must name the stopping invariant",
      );

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stopFiber);
      assert.isFalse(
        yield* adapter.hasSession(threadId),
        "the session is gone once teardown completes",
      );
    }),
  );

  it.effect("rejects a racing turn while stopping even with no active turn at stop time", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        sendTurn: () => Effect.void,
        stopSession: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(releaseStop)),
          ),
      });

      // No turn is running when stop begins — but stopping must still bar a racer.
      yield* start(adapter);
      const stopFiber = yield* Effect.forkChild(adapter.stopSession(threadId));
      yield* Deferred.await(entered);

      const raced = yield* Effect.exit(adapter.sendTurn({ threadId, input: "racer" } as never));
      assert.strictEqual(
        raced._tag,
        "Failure",
        "a turn racing a stopping session must fail even with no active turn",
      );
      assert.isTrue(
        String(raced._tag === "Failure" ? raced.cause : "").includes("session is stopping"),
        "the rejection must name the stopping invariant",
      );

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stopFiber);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("keeps session bookkeeping in the host", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        sendTurn: () => Effect.void,
        // A plugin that fails to stop must not leave a session the host can never
        // clean up.
        stopSession: () => Effect.fail(new DriverExploded("cannot stop")),
      });

      yield* start(adapter);
      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.strictEqual((yield* adapter.listSessions()).length, 1);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId), "the host drops it regardless");
    }),
  );

  it.effect("refuses the members a plugin provider does not support", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor({
        startSession: () => Effect.void,
        sendTurn: () => Effect.void,
        stopSession: () => Effect.void,
      });

      // Typed failures, not lies. A plugin faking rollback would corrupt checkpointing.
      const rollback = yield* Effect.exit(adapter.rollbackThread(threadId, 1));
      assert.strictEqual(rollback._tag, "Failure");
      const read = yield* Effect.exit(adapter.readThread(threadId));
      assert.strictEqual(read._tag, "Failure");
    }),
  );
});
