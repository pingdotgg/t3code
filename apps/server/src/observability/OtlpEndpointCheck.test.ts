import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as NetAddress from "effect/net/NetAddress";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OtlpEndpointCheck from "./OtlpEndpointCheck.ts";

interface PostedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Answers every post with `status`, or fails like a refused connection when it is null. */
const checkWith = (
  status: number | null,
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>,
) => {
  const requests: Array<PostedRequest> = [];
  const httpClient = HttpClient.make((request, _url, signal) => {
    requests.push({
      url: request.url,
      headers: request.headers,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      signal,
    });
    return status === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({ ...config, ...overrides });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-otlp-check-" })));
  const layer = OtlpEndpointCheck.layer.pipe(
    Layer.provide(httpClientLayer ?? Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  return { requests, layer };
};

const check = (input: Parameters<OtlpEndpointCheck.OtlpEndpointCheck["Service"]["check"]>[0]) =>
  Effect.gen(function* () {
    const service = yield* OtlpEndpointCheck.OtlpEndpointCheck;
    return yield* service.check(input);
  });

describe("OtlpEndpointCheck", () => {
  it.effect("posts an empty export for the signal with the T3 headers", () => {
    const { requests, layer } = checkWith(200, {
      otlpMetricsUrl: "http://collector:4318/v1/metrics",
      otlpMetricsExport: { ...DEFAULT_SIGNAL_EXPORT, headers: { authorization: "Bearer t3" } },
    });
    return Effect.gen(function* () {
      const result = yield* check({ signal: "metrics", url: "http://collector:4318/v1/metrics" });

      assert.strictEqual(result._tag, "Accepted");
      assert.lengthOf(requests, 1);
      assert.strictEqual(requests[0]?.url, "http://collector:4318/v1/metrics");
      assert.strictEqual(requests[0]?.headers.authorization, "Bearer t3");
      assert.strictEqual(requests[0]?.body, `{"resourceMetrics":[]}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps T3 credentials paired with each running signal endpoint", () => {
    const signalExport = { ...DEFAULT_SIGNAL_EXPORT, headers: { "x-api-key": "secret" } };
    const { requests, layer } = checkWith(200, {
      otlpTracesUrl: "https://collector.example.com/v1/traces",
      otlpMetricsUrl: "https://collector.example.com/v1/metrics",
      otlpLogsUrl: "https://collector.example.com/v1/logs",
      otlpTracesExport: signalExport,
      otlpMetricsExport: signalExport,
      otlpLogsExport: signalExport,
      otelEnvironment: OtelEnvironment.none,
    });
    return Effect.gen(function* () {
      for (const signal of ["traces", "metrics", "logs"] as const) {
        const runningUrl = `https://collector.example.com/v1/${signal}`;
        yield* check({ signal, url: runningUrl });
        yield* check({ signal, url: "https://elsewhere.example.com/collect" });
        yield* check({ signal, url: `${runningUrl}/other` });
        yield* check({ signal, url: `${runningUrl}?tenant=other` });
      }

      assert.lengthOf(requests, 12);
      requests.forEach((request, index) => {
        if (index % 4 === 0) assert.strictEqual(request.headers["x-api-key"], "secret");
        else assert.isUndefined(request.headers["x-api-key"]);
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not send export credentials when the signal has no running endpoint", () => {
    const { requests, layer } = checkWith(200, {
      otlpLogsUrl: undefined,
      otlpLogsExport: { ...DEFAULT_SIGNAL_EXPORT, headers: { authorization: "Bearer t3" } },
      otelEnvironment: OtelEnvironment.none,
    });
    return Effect.gen(function* () {
      const result = yield* check({ signal: "logs", url: "https://new.example.com/v1/logs" });

      assert.strictEqual(result._tag, "Accepted");
      assert.lengthOf(requests, 1);
      assert.isUndefined(requests[0]?.headers.authorization);
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases the request once the status is known", () => {
    const { requests, layer } = checkWith(200);
    return Effect.gen(function* () {
      yield* check({ signal: "traces", url: "http://collector:4318/v1/traces" });

      assert.isTrue(requests[0]?.signal.aborted);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps endpoint URLs and credentials out of traces", () => {
    const url = "https://collector.example.com/v1/logs?api_key=query-secret";
    const { requests, layer } = checkWith(200, {
      otlpLogsUrl: url,
      otlpLogsExport: {
        ...DEFAULT_SIGNAL_EXPORT,
        headers: { "x-honeycomb-team": "header-secret" },
      },
      otelEnvironment: OtelEnvironment.none,
    });
    const recorded: Array<unknown> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          recorded.push({ name: span.name, attributes: Object.fromEntries(span.attributes) });
        };
        return span;
      },
    });
    return Effect.gen(function* () {
      yield* check({ signal: "logs", url }).pipe(Effect.withTracer(tracer));

      assert.strictEqual(requests[0]?.headers["x-honeycomb-team"], "header-secret");
      assert.notInclude(JSON.stringify(recorded), "secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not forward credentials through a receiver redirect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<{ url: string; apiKey: string | undefined }> = [];
        const server = yield* HttpServer.HttpServer;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* request.text;
            requests.push({ url: request.url, apiKey: request.headers["x-api-key"] });
            return request.url === "/v1/traces"
              ? HttpServerResponse.redirect("/other", { status: 307 })
              : HttpServerResponse.empty({ status: 200 });
          }),
        );
        if (!NetAddress.isInetAddress(server.address)) {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        const url = `http://127.0.0.1:${server.address.port}/v1/traces`;
        const { layer } = checkWith(
          200,
          {
            otlpTracesUrl: url,
            otlpTracesExport: { ...DEFAULT_SIGNAL_EXPORT, headers: { "x-api-key": "secret" } },
          },
          FetchHttpClient.layer,
        );
        const result = yield* check({ signal: "traces", url }).pipe(Effect.provide(layer));

        assert.deepStrictEqual(result, { _tag: "Rejected", status: 307 });
        assert.deepStrictEqual(requests, [{ url: "/v1/traces", apiKey: "secret" }]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports the status a receiver rejects the export with", () => {
    const { layer } = checkWith(401);
    return Effect.gen(function* () {
      const result = yield* check({ signal: "traces", url: "http://collector:4318/v1/traces" });

      assert.deepStrictEqual(result, { _tag: "Rejected", status: 401 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an endpoint that cannot be reached", () => {
    const { layer } = checkWith(null);
    return Effect.gen(function* () {
      const result = yield* check({ signal: "logs", url: "http://localhost:1/v1/logs" });

      assert.deepStrictEqual(result, { _tag: "Unreachable", timedOut: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps OTEL endpoint credentials off other endpoints", () => {
    const otelUrl = "https://otel.example.com/v1/traces";
    const otelExport = { ...DEFAULT_SIGNAL_EXPORT, headers: { "x-api-key": "secret" } };
    const { requests, layer } = checkWith(200, {
      otlpTracesUrl: otelUrl,
      otlpTracesExport: otelExport,
      otelEnvironment: {
        ...OtelEnvironment.none,
        traces: OtelEnvironment.OtelSignal.Export({
          url: otelUrl,
          protocol: otelExport.protocol,
          headers: otelExport.headers,
        }),
      },
    });
    return Effect.gen(function* () {
      yield* check({ signal: "traces", url: otelUrl });
      yield* check({ signal: "traces", url: "https://elsewhere.example.com/v1/traces" });

      assert.strictEqual(requests[0]?.headers["x-api-key"], "secret");
      assert.isUndefined(requests[1]?.headers["x-api-key"]);
    }).pipe(Effect.provide(layer));
  });
});
