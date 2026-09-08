import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "alchemy-test";
import { importStack } from "../../src/Cli/commands/_shared";
import { devKeepAlive } from "../../src/Cli/commands/deploy";
import { PlatformServices } from "../../src/Util/PlatformServices";

// `alchemy dev` runs under `--watch`: exiting the process on error cancels
// the watch session, so a run wrapped in `devKeepAlive` must park (stay
// alive for the watcher to restart) on ANY failure — typed error or defect —
// while success and interruption pass through untouched.

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

  test("an interrupt-only cause propagates instead of parking", async () => {
    const exit = await Effect.runPromiseExit(
      devKeepAlive(Effect.failCause(Cause.interrupt())),
    );
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(
      true,
    );
  });

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
  // Before the guard this crashed the exec process and killed the watch
  // session; wrapped in `devKeepAlive` it must park until the next save.
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
