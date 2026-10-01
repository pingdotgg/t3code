import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "alchemy-test";
import { importStack } from "@/Alchemist/Session.ts";
import { devKeepAlive } from "../../src/Cli/exec";
import { PlatformServices } from "../../src/Util/PlatformServices";

// The dev loop interrupts a parked run when a stack dependency changes (Node
// reloads in-process; Bun exits for the supervisor to respawn). In both cases a
// failed generation must park instead of exiting, while interruption propagates.

/** Resolves `true` when the effect is still running (parked) after the timeout. */
const parks = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.timeoutOption("50 millis"), Effect.map(Option.isNone)),
  );

describe("devKeepAlive", () => {
  test("passes success through untouched", () =>
    expect(Effect.runPromise(devKeepAlive(Effect.succeed(42)))).resolves.toBe(
      42,
    ));

  test("parks on a typed failure instead of exiting", () =>
    expect(
      parks(devKeepAlive(Effect.fail(new Error("plan failed")))),
    ).resolves.toBe(true));

  test("parks on a defect instead of exiting", () =>
    expect(
      parks(
        devKeepAlive(Effect.die(new TypeError("undefined is not an object"))),
      ),
    ).resolves.toBe(true));

  // A run that ends by itself with nothing but interruptions in its cause was
  // cancelled from the inside (a provider or engine race), not by the user.
  // It must park like any other failure; letting it propagate exited dev
  // with a bare "Interrupted." and no hint of what went wrong (#1461).
  test("an internal interrupt-only cause parks instead of exiting", () =>
    expect(
      parks(devKeepAlive(Effect.failCause(Cause.interrupt()))),
    ).resolves.toBe(true));

  test("interruption tears down a run that is still working (Ctrl-C in dev)", () =>
    expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            devKeepAlive(Effect.sleep("1 second")),
          );
          yield* Effect.sleep("20 millis");
          const exit = yield* Fiber.interrupt(fiber).pipe(
            Effect.andThen(Fiber.await(fiber)),
          );
          return exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause);
        }),
      ),
    ).resolves.toBe(true));

  test("interruption still tears down a parked run (Ctrl-C in dev)", () =>
    expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            devKeepAlive(Effect.die("apply failed")),
          );
          yield* Effect.sleep("20 millis");
          yield* Fiber.interrupt(fiber);
          return "shut down";
        }),
      ),
    ).resolves.toBe("shut down"));

  // The real-world crash: a mid-edit save makes the stack entrypoint throw at
  // module evaluation, so `importStack`'s dynamic import rejects (a defect).
  // Wrapped in `devKeepAlive`, it must park until the import watcher observes
  // the next save and interrupts this generation.
  test("a stack module that throws at evaluation parks instead of crashing", () =>
    expect(
      parks(
        devKeepAlive(
          importStack(
            fileURLToPath(
              import.meta.resolve("./fixtures/import-stack-throws.ts"),
            ),
          ).pipe(Effect.provide(PlatformServices)),
        ),
      ),
    ).resolves.toBe(true));
});
