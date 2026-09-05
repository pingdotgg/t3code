import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TraceRecord } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as BrowserTraceCollector from "../BrowserTraceCollector.ts";
import { ObservabilityLive } from "./Observability.ts";

const browserTraceRecord: TraceRecord = {
  type: "otlp-span",
  name: "browser.test",
  kind: "internal",
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  sampled: true,
  startTimeUnixNano: "1000000",
  endTimeUnixNano: "2000000",
  durationMs: 1,
  attributes: {},
  events: [],
  links: [],
  resourceAttributes: {
    "service.name": "t3-web",
  },
  scope: {
    name: "effect",
    attributes: {},
  },
};

it.layer(NodeServices.layer)("server observability", (it) => {
  it.effect("does not create a trace file for server or browser spans when disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-observability-off-" });
      const tracePath = path.join(baseDir, "disabled-traces", "server.trace.ndjson");
      const defaultConfig = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const config = ServerConfig.make({
        ...defaultConfig,
        traceMinLevel: "None",
        serverTracePath: tracePath,
      });
      const observabilityLayer = ObservabilityLive.pipe(
        Layer.provideMerge(ResourceAttribution.layer),
        Layer.provide(ServerConfig.layer(config)),
      );

      yield* Effect.gen(function* () {
        const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
        yield* Effect.void.pipe(Effect.withSpan("server.test"));
        yield* browserTraceCollector.record([browserTraceRecord]);
      }).pipe(Effect.provide(observabilityLayer));

      assert.isFalse(yield* fs.exists(tracePath));
      assert.isFalse(yield* fs.exists(path.dirname(tracePath)));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
