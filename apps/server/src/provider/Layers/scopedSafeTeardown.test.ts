import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { describe, expect } from "vitest";

import { scopedSafeTeardown } from "./scopedSafeTeardown.ts";

describe("scopedSafeTeardown", () => {
  it.effect("returns the body's value when teardown is clean", () =>
    Effect.gen(function* () {
      const finalizers: string[] = [];
      const wrapped = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalizers.push("clean");
          }),
        );
        return "body-ok";
      }).pipe(scopedSafeTeardown("test"));

      const value = yield* wrapped;
      expect(value).toBe("body-ok");
      expect(finalizers).toEqual(["clean"]);
    }),
  );

  it.effect("preserves body success when a finalizer dies", () =>
    // The production failure mode: `Layer.build(...)` registers a finalizer
    // that kills a subprocess; if the kill fails, the defect would otherwise
    // override a successful probe body.
    Effect.gen(function* () {
      const finalizers: string[] = [];
      const wrapped = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalizers.push("ran-before-die");
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.die(new Error("simulated subprocess kill failure")),
        );
        return "body-ok";
      }).pipe(scopedSafeTeardown("test"));

      const value = yield* wrapped;
      expect(value).toBe("body-ok");
      // The clean finalizer still ran; teardown defect was logged + swallowed.
      expect(finalizers).toEqual(["ran-before-die"]);
    }),
  );

  it.effect("preserves typed body failures even when teardown is clean", () =>
    Effect.gen(function* () {
      class BodyError {
        readonly _tag = "BodyError" as const;
      }
      const wrapped = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.void);
        return yield* Effect.fail(new BodyError());
      }).pipe(scopedSafeTeardown("test"));

      const exit = yield* Effect.exit(wrapped);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Body's typed failure should surface, not a defect.
        const squashed = Cause.squash(exit.cause);
        expect(squashed).toBeInstanceOf(BodyError);
      }
    }),
  );

  it.effect("prefers the body's typed failure over a teardown defect", () =>
    // Even when both the body fails AND teardown defects, the body's typed
    // failure is what callers see. This matters because `Effect.result` /
    // `.pipe(Effect.exit)` in callers expects a typed Failure, not a Die.
    Effect.gen(function* () {
      class BodyError {
        readonly _tag = "BodyError" as const;
      }
      const wrapped = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.die(new Error("simulated subprocess kill failure")),
        );
        return yield* Effect.fail(new BodyError());
      }).pipe(scopedSafeTeardown("test"));

      const exit = yield* Effect.exit(wrapped);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const squashed = Cause.squash(exit.cause);
        expect(squashed).toBeInstanceOf(BodyError);
      }
    }),
  );
});
