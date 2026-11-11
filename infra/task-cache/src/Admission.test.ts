import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Admission from "./Admission.ts";

it.effect("rejects excess uploads immediately and releases interrupted uploads", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.Admission;
    const entered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const first = yield* admission
      .withPermit(true, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* admission
      .withPermit(
        true,
        Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(secondEntered);
    const rejected = yield* admission
      .withPermit(true, Effect.die("must not run"))
      .pipe(Effect.exit);
    expect(rejected).toEqual(Exit.fail(new Admission.AdmissionRejected()));
    yield* Fiber.interrupt(first);
    expect(yield* admission.withPermit(true, Effect.succeed("restored"))).toBe("restored");
    yield* Fiber.interrupt(second);
  }).pipe(Effect.provide(Admission.layer)),
);

it.effect("reads continue while all upload slots are occupied", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.Admission;
    const entered = yield* Deferred.make<void>();
    const occupied = yield* admission
      .withPermit(
        true,
        admission.withPermit(
          true,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(yield* admission.withPermit(false, Effect.succeed("hit"))).toBe("hit");
    yield* Fiber.interrupt(occupied);
  }).pipe(Effect.provide(Admission.layer)),
);
