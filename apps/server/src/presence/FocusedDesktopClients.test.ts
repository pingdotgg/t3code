import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as FocusedDesktopClients from "./FocusedDesktopClients.ts";

describe("FocusedDesktopClients", () => {
  it.effect("stays focused until the last scoped desktop lease is released", () =>
    Effect.gen(function* () {
      const presence = yield* FocusedDesktopClients.FocusedDesktopClients;
      expect(yield* presence.anyFocused).toBe(false);

      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* presence.acquire.pipe(Scope.provide(first));
      yield* presence.acquire.pipe(Scope.provide(second));
      expect(yield* presence.anyFocused).toBe(true);

      yield* Scope.close(first, Exit.void);
      expect(yield* presence.anyFocused).toBe(true);

      yield* Scope.close(second, Exit.void);
      expect(yield* presence.anyFocused).toBe(false);
    }).pipe(Effect.provide(FocusedDesktopClients.layer)),
  );

  it.effect("emits only aggregate focus transitions", () =>
    Effect.gen(function* () {
      const presence = yield* FocusedDesktopClients.FocusedDesktopClients;
      const observed: boolean[] = [];
      const observer = yield* presence.changes.pipe(
        Stream.take(3),
        Stream.runForEach((focused) =>
          Effect.sync(() => {
            observed.push(focused);
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* presence.acquire.pipe(Scope.provide(first));
      yield* presence.acquire.pipe(Scope.provide(second));
      yield* Scope.close(first, Exit.void);
      yield* Scope.close(second, Exit.void);
      yield* Fiber.join(observer);

      expect(observed).toEqual([false, true, false]);
    }).pipe(Effect.provide(FocusedDesktopClients.layer)),
  );

  it.effect("holds a focus lease for the full lifetime of the RPC stream", () =>
    Effect.gen(function* () {
      const presence = yield* FocusedDesktopClients.FocusedDesktopClients;
      const stream = yield* FocusedDesktopClients.holdFocusLease(presence).pipe(
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true }),
      );

      for (let iteration = 0; iteration < 100 && !(yield* presence.anyFocused); iteration++) {
        yield* Effect.yieldNow;
      }
      expect(yield* presence.anyFocused).toBe(true);

      yield* Fiber.interrupt(stream);
      expect(yield* presence.anyFocused).toBe(false);
    }).pipe(Effect.provide(FocusedDesktopClients.layer)),
  );
});
