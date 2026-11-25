import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as NetAddress from "effect/net/NetAddress";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { OtlpSerialization } from "effect/observability";
import { describe } from "vite-plus/test";

import { otlpExportAttemptFailuresTotal } from "./Metrics.ts";
import * as OtlpExportFailures from "./OtlpExportFailures.ts";

const failures = (reason: string) =>
  Metric.value(
    Metric.withAttributes(otlpExportAttemptFailuresTotal, { signal: "logs", reason }),
  ).pipe(Effect.map((state) => state.count));

describe("OtlpExportFailures", () => {
  it.effect("counts each failed attempt by reason and leaves successes alone", () => {
    const outcomes: Array<number | "transport"> = [503, "transport", 200];
    const client = HttpClient.make((request) => {
      const outcome = outcomes.shift() ?? 200;
      return outcome === "transport"
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: outcome })),
          );
    });
    const serialization = OtlpSerialization.OtlpSerialization.of({
      traces: () => HttpBody.empty,
      metrics: () => HttpBody.empty,
      logs: () => {
        throw new Error("unencodable attribute");
      },
    });
    const layer = OtlpExportFailures.layer("logs").pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(Layer.succeed(OtlpSerialization.OtlpSerialization, serialization)),
    );

    return Effect.gen(function* () {
      const counted = yield* HttpClient.HttpClient;
      const encode = yield* OtlpSerialization.OtlpSerialization;
      const request = HttpClientRequest.post("http://localhost:4318/v1/logs");
      yield* counted.execute(request);
      yield* Effect.flip(counted.execute(request));
      yield* counted.execute(request);
      assert.throws(() => encode.logs({ resourceLogs: [] }), "unencodable attribute");

      const transport = yield* Metric.value(
        Metric.withAttributes(otlpExportAttemptFailuresTotal, {
          signal: "logs",
          reason: "transport",
        }),
      );
      // OTLP marks the sum monotonic only for an incremental counter.
      assert.isTrue(transport.incremental);
      assert.deepStrictEqual(
        [
          yield* failures("status_503"),
          yield* failures("transport"),
          yield* failures("encode"),
          yield* failures("status_200"),
        ],
        [1, 1, 1, 0],
      );
    }).pipe(Effect.provide(layer), Effect.provideService(Metric.MetricRegistry, new Map()));
  });

  it.effect("does not follow receiver redirects or forward credentials on OTLP export", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<{ url: string; apiKey: string | undefined }> = [];
        const server = yield* HttpServer.HttpServer;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* request.text;
            requests.push({ url: request.url, apiKey: request.headers["x-api-key"] });
            return request.url === "/v1/logs"
              ? HttpServerResponse.redirect("/stolen", { status: 307 })
              : HttpServerResponse.empty({ status: 200 });
          }),
        );
        const serverAddress = server.address;
        if (!NetAddress.isInetAddress(serverAddress)) {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        const layer = OtlpExportFailures.layer("logs").pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(OtlpSerialization.layerJson),
        );
        const response = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.post(`http://127.0.0.1:${serverAddress.port}/v1/logs`, {
            headers: { "x-api-key": "otlp-secret" },
            body: HttpBody.text("{}"),
          });
        }).pipe(Effect.provide(layer));

        assert.strictEqual(response.status, 307);
        assert.deepStrictEqual(requests, [{ url: "/v1/logs", apiKey: "otlp-secret" }]);
        assert.strictEqual(yield* failures("status_307"), 1);
      }),
    ).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
});
