import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("never queues or sends an event", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    assert.strictEqual(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }), false);
    assert.strictEqual(yield* analytics.record("any.event", undefined, { anonymous: true }), false);
    yield* analytics.recordOwners([{ source: "device", ownerId: "owner" }], "client");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
