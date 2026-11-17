import { describe, expect, it } from "@effect/vitest";
import { type AgentAlert, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as AgentAlerts from "./AgentAlerts.ts";

const alert = {
  id: "tool-1",
  threadId: ThreadId.make("thread-1"),
  body: "fleet.lock stuck",
} satisfies AgentAlert;

describe("AgentAlerts", () => {
  it.effect("reports no delivery when no client is subscribed", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      expect(yield* alerts.offer(alert)).toBe(false);
    }).pipe(Effect.provide(AgentAlerts.layer)),
  );

  it.effect("delivers to every subscribed client until it disconnects", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      const first = yield* Queue.unbounded<AgentAlert>();
      const second = yield* Queue.unbounded<AgentAlert>();
      const firstClient = yield* alerts.stream.pipe(
        Stream.runForEach((item) => Queue.offer(first, item)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const secondClient = yield* alerts.stream.pipe(
        Stream.runForEach((item) => Queue.offer(second, item)),
        Effect.forkScoped({ startImmediately: true }),
      );

      expect(yield* alerts.offer(alert)).toBe(true);
      expect(yield* Queue.take(first)).toEqual(alert);
      expect(yield* Queue.take(second)).toEqual(alert);

      yield* Fiber.interrupt(firstClient);
      expect(yield* alerts.offer(alert)).toBe(true);
      expect(yield* Queue.take(second)).toEqual(alert);

      yield* Fiber.interrupt(secondClient);
      expect(yield* alerts.offer(alert)).toBe(false);
    }).pipe(Effect.provide(AgentAlerts.layer), Effect.scoped),
  );
});
