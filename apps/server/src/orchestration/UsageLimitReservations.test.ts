import type { ProviderSession, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as Effect from "effect/Effect";

import { MAX_CONCURRENT_PROVIDER_TURNS } from "./ConcurrentTurnPolicy.ts";
import { make as makeService, layer, UsageLimitReservations } from "./UsageLimitReservations.ts";

const make = (listSessions: ProviderService["Service"]["listSessions"]) =>
  makeService.pipe(Effect.provide(Layer.mock(ProviderService)({ listSessions })));

function session(index: number): ProviderSession {
  return {
    threadId: `running-${index}` as ThreadId,
    status: "running",
  } as ProviderSession;
}

describe("UsageLimitReservations", () => {
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
            Layer.mock(ProviderService)({
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

  it.effect("releases a handover slot after completion", () =>
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
