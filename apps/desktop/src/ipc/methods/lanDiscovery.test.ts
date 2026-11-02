import { expect, it } from "@effect/vitest";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { scanLanServices } from "./lanDiscovery.ts";

it.effect("returns services observed during the scan and stops browsing", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<
      (
        services: ReadonlyArray<{
          id: string;
          environmentId: string;
          addresses: ReadonlyArray<string>;
          port: number;
        }>,
      ) => void
    >();
    let stopped = false;
    const scan = yield* scanLanServices((onChange) => {
      Queue.offerUnsafe(started, onChange);
      return {
        refresh: () => {},
        stop: () => {
          stopped = true;
        },
      };
    }).pipe(Effect.forkChild({ startImmediately: true }));
    const emit = yield* Queue.take(started);
    emit([{ id: "desk", environmentId: "environment", addresses: ["192.168.1.22"], port: 3773 }]);
    yield* TestClock.adjust("1500 millis");
    expect(yield* Fiber.join(scan)).toEqual([
      { id: "desk", environmentId: "environment", addresses: ["192.168.1.22"], port: 3773 },
    ]);
    expect(stopped).toBe(true);
  }),
);
