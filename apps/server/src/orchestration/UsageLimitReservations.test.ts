import type { ProviderSession, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { MAX_CONCURRENT_PROVIDER_TURNS } from "./ConcurrentTurnPolicy.ts";
import { make as makeService, layer, UsageLimitReservations } from "./UsageLimitReservations.ts";

const make = (listSessions: ProviderService.ProviderService["Service"]["listSessions"]) =>
  makeService.pipe(Effect.provide(Layer.mock(ProviderService.ProviderService)({ listSessions })));

function session(index: number): ProviderSession {
  return {
    threadId: `running-${index}` as ThreadId,
    status: "running",
  } as ProviderSession;
}

function assertReleasedReservationRemainsVisible(kind: "turn" | "handover") {
  return Effect.scoped(
    Effect.gen(function* () {
      let runningSessions = Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) =>
        session(index),
      );
      let pauseSnapshot = false;
      const snapshotStarted = yield* Deferred.make<void>();
      const resumeSnapshot = yield* Deferred.make<void>();
      const reservations = yield* make(() =>
        Effect.gen(function* () {
          const snapshot = [...runningSessions];
          if (pauseSnapshot) {
            yield* Deferred.succeed(snapshotStarted, undefined);
            yield* Deferred.await(resumeSnapshot);
          }
          return snapshot;
        }),
      );
      const reserve = kind === "turn" ? reservations.reserveTurn : reservations.reserveHandover;

      expect(
        yield* reserve({
          key: `${kind}:eighth`,
          threadId: "thread-eighth" as ThreadId,
        }),
      ).toBeUndefined();

      pauseSnapshot = true;
      const ninthReservation = yield* reserve({
        key: `${kind}:ninth`,
        threadId: "thread-ninth" as ThreadId,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(snapshotStarted);
      runningSessions = [
        ...runningSessions,
        {
          ...session(MAX_CONCURRENT_PROVIDER_TURNS - 1),
          threadId: "thread-eighth" as ThreadId,
        },
      ];
      const releaseEighth = yield* reservations.release(`${kind}:eighth`).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(releaseEighth.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(resumeSnapshot, undefined);

      expect(yield* Fiber.join(ninthReservation)).toMatchObject({
        code: "concurrent-turn-limit",
      });
      yield* Fiber.join(releaseEighth);
    }),
  );
}

describe("UsageLimitReservations", () => {
  it.effect("keeps a released turn reservation visible to an in-flight snapshot", () =>
    assertReleasedReservationRemainsVisible("turn"),
  );

  it.effect("keeps a released handover reservation visible to an in-flight snapshot", () =>
    assertReleasedReservationRemainsVisible("handover"),
  );

  it.effect("shares admission capacity between runtime consumers", () =>
    Effect.gen(function* () {
      const turnConsumer = yield* UsageLimitReservations;
      const handoverConsumer = yield* UsageLimitReservations;
      expect(
        yield* turnConsumer.reserveTurn({
          key: "turn:one",
          threadId: "thread-one" as ThreadId,
        }),
      ).toBeUndefined();
      expect(
        yield* handoverConsumer.reserveHandover({
          key: "handover:two",
          threadId: "thread-two" as ThreadId,
        }),
      ).toMatchObject({ code: "concurrent-turn-limit" });
      yield* turnConsumer.release("turn:one");
      expect(
        yield* handoverConsumer.reserveHandover({
          key: "handover:two",
          threadId: "thread-two" as ThreadId,
        }),
      ).toBeUndefined();
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(ProviderService.ProviderService)({
              listSessions: () =>
                Effect.succeed(
                  Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) =>
                    session(index),
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("atomically reserves the final provider-work slot", () =>
    Effect.gen(function* () {
      const reservations = yield* make(() =>
        Effect.succeed(
          Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) => session(index)),
        ),
      );

      const results = yield* Effect.all(
        [
          reservations.reserveHandover({
            key: "handover:one",
            threadId: "thread-one" as ThreadId,
          }),
          reservations.reserveHandover({
            key: "handover:two",
            threadId: "thread-two" as ThreadId,
          }),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      expect(results.filter((result) => result?.code === "concurrent-turn-limit")).toHaveLength(1);
    }),
  );

  it.effect("preserves same-thread followups when provider capacity is full", () =>
    Effect.gen(function* () {
      const reservations = yield* make(() =>
        Effect.succeed(
          Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS }, (_, index) => session(index)),
        ),
      );

      expect(
        yield* reservations.reserveTurn({
          key: "turn:followup",
          threadId: "running-0" as ThreadId,
        }),
      ).toBeUndefined();
      yield* reservations.release("turn:followup");
      expect(
        yield* reservations.reserveTurn({
          key: "turn:new-thread",
          threadId: "thread-new" as ThreadId,
        }),
      ).toMatchObject({ code: "concurrent-turn-limit" });
    }),
  );

  it.effect("releases admission synchronization when snapshot lookup is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let pauseSnapshot = true;
        const snapshotStarted = yield* Deferred.make<void>();
        const resumeSnapshot = yield* Deferred.make<void>();
        const reservations = yield* make(() =>
          pauseSnapshot
            ? Deferred.succeed(snapshotStarted, undefined).pipe(
                Effect.andThen(Deferred.await(resumeSnapshot)),
                Effect.as<ReadonlyArray<ProviderSession>>([]),
              )
            : Effect.succeed([]),
        );
        const interruptedReservation = yield* reservations
          .reserveTurn({
            key: "turn:interrupted",
            threadId: "thread-interrupted" as ThreadId,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(snapshotStarted);
        yield* Fiber.interrupt(interruptedReservation);

        pauseSnapshot = false;
        expect(
          yield* reservations.reserveTurn({
            key: "turn:after-interrupt",
            threadId: "thread-after-interrupt" as ThreadId,
          }),
        ).toBeUndefined();
      }),
    ),
  );

  it.effect("releases a handover slot idempotently after completion", () =>
    Effect.gen(function* () {
      const reservations = yield* make(() =>
        Effect.succeed(
          Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) => session(index)),
        ),
      );

      expect(
        yield* reservations.reserveHandover({
          key: "handover:first",
          threadId: "thread-first" as ThreadId,
        }),
      ).toBeUndefined();
      yield* reservations.release("handover:first");
      yield* reservations.release("handover:first");
      expect(
        yield* reservations.reserveHandover({
          key: "handover:second",
          threadId: "thread-second" as ThreadId,
        }),
      ).toBeUndefined();
    }),
  );

  it.effect("rejects duplicate generation for one source thread", () =>
    Effect.gen(function* () {
      const reservations = yield* make(() => Effect.succeed([]));
      const threadId = "thread-source" as ThreadId;

      expect(
        yield* reservations.reserveHandover({ key: "handover:first", threadId }),
      ).toBeUndefined();
      expect(
        yield* reservations.reserveHandover({ key: "handover:second", threadId }),
      ).toMatchObject({ code: "handover-in-progress" });
    }),
  );
});
