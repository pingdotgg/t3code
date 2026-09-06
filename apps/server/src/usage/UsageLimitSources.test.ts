import { assert, describe, it } from "@effect/vitest";
import { UsageLimitSourceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { layerTest } from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const backgroundPolicy = Layer.succeed(BackgroundPolicy, {
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.die("unused"),
  streamChanges: Stream.empty,
  subscribe: Effect.die("unused"),
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

describe("UsageLimitSources refresh interval", () => {
  it.effect.each([
    { interval: Duration.seconds(0), expectedReads: 1 },
    { interval: Duration.minutes(1), expectedReads: 2 },
  ])("polls only when enabled: $expectedReads reads", ({ interval, expectedReads }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads = yield* Ref.make(0);
        const httpClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Ref.update(reads, (count) => count + 1).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({ accounts: {} }))),
            ),
          ),
        );
        const sources = yield* UsageLimitSources.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              backgroundPolicy,
              httpClient,
              layerTest({
                providerHealthRefreshInterval: interval,
                usageLimitSources: {
                  [UsageLimitSourceId.make("hub")]: {
                    kind: "cliproxy",
                    url: "https://hub.example.com",
                    managementKey: "test-key",
                    enabled: true,
                  },
                },
              }),
            ),
          ),
        );
        yield* sources.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots.length === 1),
          Stream.runHead,
        );
        assert.strictEqual(yield* Ref.get(reads), 1);

        yield* TestClock.adjust("61 seconds");
        assert.strictEqual(yield* Ref.get(reads), expectedReads);

        yield* sources.refresh;
        assert.strictEqual(yield* Ref.get(reads), expectedReads + 1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
