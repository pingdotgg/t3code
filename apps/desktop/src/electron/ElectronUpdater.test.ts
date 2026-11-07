import * as NodeEvents from "node:events";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makePrepareInstall, type NativeUpdater } from "./ElectronUpdater.ts";

class FakeSquirrel implements NativeUpdater {
  readonly events = new NodeEvents.EventEmitter();
  checks = 0;
  answer: (squirrel: FakeSquirrel) => void = () => {};
  on(event: string, listener: (...args: Array<never>) => void) {
    this.events.on(event, listener as (...args: Array<unknown>) => void);
  }
  // NativeUpdater listeners take specific arguments; the emitter passes whatever was emitted.
  once(event: string, listener: (...args: Array<never>) => void) {
    this.events.once(event, listener as (...args: Array<unknown>) => void);
  }
  removeListener(event: string, listener: (...args: Array<never>) => void) {
    this.events.removeListener(event, listener as (...args: Array<unknown>) => void);
  }
  emit(event: string, ...args: Array<unknown>) {
    this.events.emit(event, ...args);
  }
  checkForUpdates() {
    this.checks += 1;
    this.answer(this);
  }
}

// One persistent watcher per event outlives each prepare; its own listeners must not.
const settledListeners = (squirrel: FakeSquirrel) =>
  ["update-downloaded", "update-not-available", "error"].map((event) =>
    squirrel.events.listenerCount(event),
  );

describe("prepareInstall", () => {
  it.effect("succeeds once Squirrel has the update and stops listening", () =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      squirrel.answer = (fake) => fake.emit("update-downloaded");
      yield* makePrepareInstall(() => squirrel);
      assert.deepEqual(settledListeners(squirrel), [1, 1, 1]);
    }),
  );

  it.effect.each([
    ["an error", (fake: FakeSquirrel) => fake.emit("error", new Error("No space left on device"))],
    ["no update", (fake: FakeSquirrel) => fake.emit("update-not-available")],
    [
      "a throw",
      () => {
        throw new Error("no feed URL");
      },
    ],
  ] as const)("fails on %s and stops listening", ([, answer]) =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      squirrel.answer = answer;
      const error = yield* Effect.flip(makePrepareInstall(() => squirrel));
      assert.equal(error._tag, "ElectronUpdaterPrepareInstallError");
      assert.deepEqual(settledListeners(squirrel), [1, 1, 1]);
    }),
  );

  it.effect("counts a prepare that finished after the timeout", () =>
    Effect.gen(function* () {
      const squirrel = new FakeSquirrel();
      const prepareInstall = makePrepareInstall(() => squirrel);
      const first = yield* prepareInstall.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Fiber.join(first))._tag, "ElectronUpdaterPrepareInstallError");

      // A retry while Squirrel is still checking waits for that check instead of starting another.
      const retry = yield* prepareInstall.pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(squirrel.checks, 1);
      squirrel.emit("update-downloaded");
      yield* Fiber.join(retry);
      yield* prepareInstall;
      assert.equal(squirrel.checks, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
