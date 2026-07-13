import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { CloudRuntimeLayerLive } from "./server.ts";

it.effect("builds the cloud runtime with all eager startup dependencies", () =>
  Effect.scoped(
    Layer.build(
      CloudRuntimeLayerLive.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-runtime-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(Effect.asVoid),
  ),
);
