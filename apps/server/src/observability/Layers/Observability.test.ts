import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import { AgentTraceExporter } from "./AgentTelemetry.ts";
import { ObservabilityLive } from "./Observability.ts";

const decodeExport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      resourceSpans: Schema.Array(
        Schema.Struct({
          scopeSpans: Schema.Array(
            Schema.Struct({ spans: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          ),
        }),
      ),
    }),
  ),
);

it.effect.each([true, false])("records only agent spans, exporter configured=%s", (configured) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-traces-" })),
    );
    const exported: Array<string> = [];
    const background: Array<string> = [];
    const collector = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.equal(request.url, "http://collector.test/v1/traces");
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array") {
          const data = decodeExport(new TextDecoder().decode(request.body.body));
          exported.push(
            ...data.resourceSpans.flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
            ),
          );
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    );
    const backgroundTracer = Tracer.make({
      span(options) {
        background.push(options.name);
        return new Tracer.NativeSpan(options);
      },
    });

    yield* Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("PortDiscovery.pollTick"));
      yield* Effect.void.pipe(Effect.withSpan("sql.execute"));
      yield* Effect.void.pipe(Effect.withSpan("http.server POST"));
      const exporter = yield* AgentTraceExporter;
      assert.equal(exporter !== undefined, configured);
      if (!exporter) return;
      const clock = yield* Clock.Clock;
      const startTime = clock.currentTimeNanosUnsafe();
      for (const name of [
        "invoke_agent T3 Code / Codex",
        "chat demo-model",
        "execute_tool shell",
      ]) {
        const span = exporter.span({
          name,
          parent: Option.none(),
          annotations: Context.empty(),
          links: [],
          startTime,
          kind: "internal",
          root: true,
          sampled: true,
        });
        span.end(startTime + 1_000_000n, Exit.void);
      }
    }).pipe(
      Effect.provide(
        ObservabilityLive.pipe(
          Layer.provide(
            ServerConfig.layer({
              ...config,
              otlpTracesUrl: configured ? "http://collector.test/v1/traces" : undefined,
              // Even a saved metrics/logs endpoint must not add background exports.
              otlpMetricsUrl: "http://collector.test/v1/metrics",
              otlpLogsUrl: "http://collector.test/v1/logs",
            }),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, collector)),
        ),
      ),
      Effect.provideService(Tracer.Tracer, backgroundTracer),
    );

    assert.deepEqual(background, []);
    assert.deepEqual(
      exported,
      configured ? ["invoke_agent T3 Code / Codex", "chat demo-model", "execute_tool shell"] : [],
    );
    assert.isFalse(yield* fs.exists(config.serverTracePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);
