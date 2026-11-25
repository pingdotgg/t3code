import { assert, it, vi } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import * as ForkNoAnalytics from "./ForkNoAnalytics.ts";

it.effect("the fork's analytics queue nothing, even with telemetry asked for", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService;
    assert.isFalse(yield* analytics.record("turn.completed", { model: "any" }));
    assert.isFalse(yield* analytics.record("agent.feedback", {}, { anonymous: true }));
  }).pipe(Effect.provide(ForkNoAnalytics.layer)),
);

const relayTracingEnvironment = {
  T3CODE_TELEMETRY_ENABLED: "true",
  T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.example.com",
  T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay",
  T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "token",
};

it.effect("the fork's relay tracing has no exporter, whatever the environment says", () =>
  Effect.gen(function* () {
    // The shipped tracing config is read from the environment when the module loads.
    for (const [name, value] of Object.entries(relayTracingEnvironment)) vi.stubEnv(name, value);
    vi.resetModules();
    const { relayLayer } = yield* Effect.promise(() => import("../cloud/relayTracing.ts"));
    const tracer = yield* RelayTracing.RelayClientTracer.pipe(
      Effect.provide(
        relayLayer({
          serviceName: "t3code-server",
          runtime: "node",
          client: "environment-server",
        }).pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(Layer.succeed(HostProcess.Environment, relayTracingEnvironment)),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    );
    assert.isTrue(Option.isNone(tracer));
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
);
