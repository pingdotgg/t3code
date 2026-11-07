import { describe, expect, it } from "@effect/vitest";
import { type AgentAlert, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as AgentAlerts from "./AgentAlerts.ts";

const alert = {
  threadId: ThreadId.make("thread-1"),
  body: "fleet.lock stuck",
} satisfies AgentAlert;

describe("AgentAlerts", () => {
  it.effect("reports no channel when nobody is listening", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      expect(yield* alerts.offer(alert)).toEqual({ local: false, phone: false });
      yield* alerts.registerPhone({
        publish: () => Effect.succeed(false),
      });
      expect(yield* alerts.offer(alert)).toEqual({ local: false, phone: false });
    }).pipe(Effect.provide(AgentAlerts.layer)),
  );

  it.effect("delivers to a connected client and a registered phone", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      const received = yield* Queue.unbounded<AgentAlert>();
      const published = yield* Deferred.make<AgentAlert>();
      yield* alerts.stream.pipe(
        Stream.runForEach((item) => Queue.offer(received, item)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* alerts.registerPhone({
        publish: (item) => Deferred.succeed(published, item).pipe(Effect.as(true)),
      });
      expect(yield* alerts.offer(alert)).toEqual({ local: true, phone: true });
      expect(yield* Queue.take(received)).toEqual(alert);
      yield* alerts.registerPhone({ publish: () => Effect.die("relay unavailable") });
      expect(yield* alerts.offer(alert)).toEqual({ local: true, phone: false });
      expect(yield* Queue.take(received)).toEqual(alert);
      expect(yield* Deferred.await(published)).toEqual(alert);
    }).pipe(Effect.provide(AgentAlerts.layer), Effect.scoped),
  );
});
