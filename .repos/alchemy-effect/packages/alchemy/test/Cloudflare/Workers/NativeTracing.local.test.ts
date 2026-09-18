import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { makeTracedWorker } from "./fixtures/native-tracing/worker.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { startOtlpCollector } from "../Utils/OtlpCollector.ts";

/**
 * `Cloudflare.Telemetry()` under `alchemy dev`: the Layer has no
 * deploy-time effect on a local Worker and the compatibility date is not
 * gated. Whether local workerd records the spans is the runtime's concern;
 * these tests pin that the fixture (KV, a Durable Object, a queue consumer,
 * forked fibers, failing and interrupted spans) runs unchanged under local
 * emulation with the Layer provided, and that OTLP composition still works.
 */
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "local Cloudflare.Telemetry() does not break the Worker under emulation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            producer: yield* makeTracedWorker("NativeTracingProducer"),
          };
        }),
      );
      expect(deployed.producer.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Every event path the fixture exercises works under local emulation
      // with the Layer provided: fetch, forked fibers, failing and
      // interrupted spans, a Durable Object RPC, and a queue round trip.
      const url = deployed.producer.url!;
      yield* expectUrlContains(`${url}/work?id=local-work`, "native-did-work");
      yield* expectUrlContains(`${url}/fanout?id=local-fanout`, "local-fanout");
      yield* expectUrlContains(`${url}/exits?id=local-exits`, "local-exits");
      yield* expectUrlContains(
        `${url}/rpc?id=local-rpc`,
        "native-did-rpc:do-ok",
      );
      yield* expectUrlContains(`${url}/enqueue?id=local-queue`, "local-queue");
      yield* expectUrlContains(`${url}/sampled`, "native-did-sample");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "local Cloudflare.Telemetry() does not gate the compatibility date",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Live deploys reject this date; dev just runs.
      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* makeTracedWorker("NativeTracingLocalOldDate", {
            compatibility: { date: "2026-03-17" },
          });
        }),
      );
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* expectUrlContains(`${worker.url}/work`, "native-did-work");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const compositionTest = (order: "cf-last" | "otlp-last") =>
  test.provider(
    `local Cloudflare.Telemetry() + logs-only OTLP compose (${order})`,
    (stack) =>
      Effect.gen(function* () {
        const collector = yield* startOtlpCollector();
        const currentConfig = yield* ConfigProvider.ConfigProvider;
        yield* stack.destroy();

        const deployed = yield* stack
          .deploy(
            Effect.gen(function* () {
              return {
                producer: yield* makeTracedWorker(
                  order === "cf-last"
                    ? "NativeTracingComposeCfLast"
                    : "NativeTracingComposeOtlpLast",
                  { compatibility: { date: "2026-08-25" } },
                ),
              };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  COLLECTOR_URL: collector.url,
                  COMPOSE_ORDER: order,
                }),
                currentConfig,
              ),
            ),
          );

        yield* expectUrlContains(deployed.producer.url!, "native-tracing-ok");
        yield* expectUrlContains(
          `${deployed.producer.url}/work`,
          "native-did-work",
        );

        yield* Effect.sync(() => collector.completedRequests.value).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("200 millis"),
            until: (posts) => posts >= 1,
            times: 40,
          }),
        );
        expect(collector.completedRequests.value).toBeGreaterThanOrEqual(1);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

compositionTest("cf-last");
compositionTest("otlp-last");
