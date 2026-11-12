import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import { packEnvValue } from "@/RuntimeContext.ts";
import { buildEventTelemetry, EXPORTERS_KEY } from "@/TelemetryRuntime.ts";

const runEvent = (
  provider: ConfigProvider.ConfigProvider,
  client: HttpClient.HttpClient,
  override?: Layer.Layer<never>,
) => {
  const context = Context.make(ConfigProvider.ConfigProvider, provider).pipe(
    Context.add(HttpClient.HttpClient, client),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const telemetry = yield* buildEventTelemetry(context, yield* Effect.scope, override);
      yield* Effect.void.pipe(Effect.withSpan("event"), Effect.provideContext(telemetry));
      yield* Metric.update(eventCounter, 1).pipe(Effect.provideContext(telemetry));
    }),
  ).pipe(Effect.provideContext(context));
};

const eventCounter = Metric.counter("telemetry_runtime_test_events_total");

const recordingClient = (requests: HttpClientRequest.HttpClientRequest[]) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, Response.json({}));
    }),
  );

describe("event telemetry configuration", { tags: ["unit", "local"] }, () => {
  it.effect("reads each destination setting once per event and releases custom telemetry", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      let acquired = 0;
      let released = 0;
      const provider = ConfigProvider.make((path) =>
        Effect.sync(() => {
          reads.push(path.join("_"));
          return undefined;
        }),
      );
      const custom = Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => acquired++),
          () => Effect.sync(() => released++),
        ),
      );
      for (let event = 1; event <= 2; event++) {
        reads.length = 0;
        yield* runEvent(provider, recordingClient(requests), custom);
        expect(reads.sort()).toEqual([
          EXPORTERS_KEY,
          "OTEL_EXPORTER_OTLP_ENDPOINT",
          "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
          "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
          "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        ]);
        expect(acquired).toBe(event);
        expect(released).toBe(event);
      }
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("rereads mutable scalar configuration and flushes each event to its destination", () =>
    Effect.gen(function* () {
      const values = new Map<string, ConfigProvider.Node>();
      const provider = ConfigProvider.make((path) => Effect.sync(() => values.get(path.join("_"))));
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const client = recordingClient(requests);
      yield* runEvent(provider, client);
      expect(requests).toHaveLength(0);

      values.set(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        ConfigProvider.makeRecord(
          new Set(["child"]),
          packEnvValue(Redacted.make("https://first.example/v1/traces")),
        ),
      );
      values.set(
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
        ConfigProvider.makeValue(packEnvValue(Redacted.make("authorization=first%20token"))),
      );
      values.set("OTEL_EXPORTER_OTLP_HEADERS", ConfigProvider.makeValue("authorization=fallback"));
      yield* runEvent(provider, client);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://first.example/v1/traces");
      expect(requests[0].headers.authorization).toBe("first token");

      values.set(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        ConfigProvider.makeArray(0, "https://second.example/v1/traces"),
      );
      values.delete("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
      yield* runEvent(provider, client);
      expect(requests).toHaveLength(2);
      expect(requests[1].url).toBe("https://second.example/v1/traces");
      expect(requests[1].headers.authorization).toBe("fallback");
    }),
  );

  it.effect("exports metrics as protobuf and traces as JSON", () =>
    Effect.gen(function* () {
      const values = new Map<string, ConfigProvider.Node>([
        ["OTEL_EXPORTER_OTLP_ENDPOINT", ConfigProvider.makeValue("https://otlp.example")],
      ]);
      const provider = ConfigProvider.make((path) => Effect.sync(() => values.get(path.join("_"))));
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      yield* runEvent(provider, recordingClient(requests));

      const contentType = (path: string) => {
        const body = requests.find(
          (request) => request.url === `https://otlp.example${path}`,
        )?.body;
        return body?._tag === "Uint8Array" ? body.contentType : undefined;
      };
      // OTLP/HTTP receivers must accept protobuf; Axiom rejects JSON metrics (415).
      expect(contentType("/v1/metrics")).toBe("application/x-protobuf");
      expect(contentType("/v1/traces")).toBe("application/json");
    }),
  );

  it.effect("treats source failures as absent configuration without swallowing other defects", () =>
    Effect.gen(function* () {
      const sourceError = new ConfigProvider.SourceError({
        message: "unavailable",
      });
      for (const [failure, exports] of [
        [Effect.fail(sourceError), 1],
        [Effect.die(sourceError), 1],
        [Effect.die("unexpected"), 0],
      ] as const) {
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const provider = ConfigProvider.make((path) =>
          path[0] === "OTEL_EXPORTER_OTLP_ENDPOINT"
            ? failure
            : Effect.succeed(
                path[0] === "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
                  ? ConfigProvider.makeValue("https://trace.example/v1/traces")
                  : undefined,
              ),
        );
        yield* runEvent(provider, recordingClient(requests));
        expect(requests).toHaveLength(exports);
      }
    }),
  );
});
