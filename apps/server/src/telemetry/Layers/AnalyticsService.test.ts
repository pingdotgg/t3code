import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body:
    | {
        readonly batch?: ReadonlyArray<{
          readonly event?: string;
          readonly properties?: {
            readonly index?: number;
          };
        }>;
      }
    | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
    };
  }>;
}

it.effect("flush drains all buffered events across multiple batches", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-telemetry-flush-"));
    const capturedRequests: Array<RecordedBatchRequest> = [];
    const telemetryLayer = AnalyticsServiceLayerLive.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), tempDir)),
    );
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: "phc_test_key",
        T3CODE_POSTHOG_HOST: "",
        T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
      }),
    );
    const batchServerLayer = HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method !== "POST") {
          return HttpServerResponse.empty({ status: 404 });
        }

        const payload = yield* request.json.pipe(
          Effect.map((body) => body as RecordedBatchRequest["body"]),
          Effect.catch(() => Effect.succeed(null)),
        );
        yield* Effect.sync(() => {
          capturedRequests.push({ path: request.url, body: payload });
        });

        return HttpServerResponse.jsonUnsafe({});
      }),
    );
    const runtimeLayer = telemetryLayer.pipe(
      Layer.provide(configLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );

    yield* Effect.gen(function* () {
      yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
      const telemetryIdentifier = yield* getTelemetryIdentifier;
      assert.equal(telemetryIdentifier !== null, true);
      const analytics = yield* AnalyticsService;

      for (let index = 0; index < 45; index += 1) {
        yield* analytics.record("test.flush.drain", { index });
      }

      yield* analytics.flush;
    }).pipe(
      Effect.provide(runtimeLayer),
      Effect.ensuring(
        Effect.sync(() => {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }),
      ),
    );

    const batchRequests = capturedRequests.filter(
      (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
        Array.isArray(request.body?.batch),
    );
    assert.equal(batchRequests.length, 3);
    assert.equal(
      batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
      true,
    );
    const deliveredIndexes = batchRequests.flatMap((request) =>
      request.body.batch
        .filter((event) => event.event === "test.flush.drain")
        .map((event) => event.properties?.index)
        .filter((index): index is number => typeof index === "number"),
    );

    const sorted = deliveredIndexes.toSorted((a, b) => a - b);
    assert.equal(sorted.length, 45);
    assert.deepEqual(
      sorted,
      Array.from({ length: 45 }, (_, index) => index),
    );
  }),
);
