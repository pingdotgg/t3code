import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { DesktopShutdown, layer as desktopShutdownLayer } from "./DesktopShutdown.ts";

const withShutdown = <A, E, R>(effect: Effect.Effect<A, E, R | DesktopShutdown>) =>
  effect.pipe(Effect.provide(desktopShutdownLayer));

describe("DesktopShutdown", () => {
  it.effect("unblocks request waiters when shutdown is requested", () =>
    withShutdown(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown;
        const waiter = yield* shutdown.awaitRequest.pipe(Effect.as("requested"), Effect.forkChild);

        yield* shutdown.request;

        assert.equal(yield* Fiber.join(waiter), "requested");
      }),
    ),
  );

  it.effect("tracks completion after resources finish closing", () =>
    withShutdown(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown;
        const waiter = yield* shutdown.awaitComplete.pipe(Effect.as("complete"), Effect.forkChild);

        assert.equal(yield* shutdown.isComplete, false);
        yield* shutdown.markComplete;

        assert.equal(yield* shutdown.isComplete, true);
        assert.equal(yield* Fiber.join(waiter), "complete");
      }),
    ),
  );

  it.effect("allows repeated requests and completion marks", () =>
    withShutdown(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown;

        yield* shutdown.request;
        yield* shutdown.request;
        yield* shutdown.markComplete;
        yield* shutdown.markComplete;

        assert.equal(yield* shutdown.isComplete, true);
      }),
    ),
  );
});
