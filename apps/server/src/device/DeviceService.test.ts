import { describe, expect, it } from "@effect/vitest";
import type { DeviceServiceState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { type DeviceService, stateStream } from "./DeviceService.ts";

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  devices: [],
  sessions: [],
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceService.stateStream", () => {
  it.effect("emits the current snapshot and then every published change", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const current = yield* Ref.make(baseState);
      const service: Pick<DeviceService["Service"], "state" | "subscribe"> = {
        state: Ref.get(current),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* stateStream(service as DeviceService["Service"]).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      for (const revision of [1, 2]) {
        const next = { ...baseState, revision, hostStatus: "ready" as const };
        yield* Ref.set(current, next);
        yield* PubSub.publish(pubsub, next);
      }
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([0, 1, 2]);
    }),
  );
});
