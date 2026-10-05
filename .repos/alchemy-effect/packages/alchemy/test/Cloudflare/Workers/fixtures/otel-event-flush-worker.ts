import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";

/**
 * Durable Object target whose events emit child spans — one HTTP fetch
 * event and one RPC method event, so both DurableObjectBridge paths get
 * telemetry coverage.
 */
export class OtelEventFlushTarget extends Cloudflare.DurableObject<OtelEventFlushTarget>()(
  "OtelEventFlushTarget",
  Effect.succeed(
    Effect.succeed({
      fetch: Effect.succeed(HttpServerResponse.text("durable-object-ok")).pipe(
        Effect.withSpan("otel-event-flush.child"),
      ),
      ping: () =>
        Effect.succeed("durable-object-rpc-ok").pipe(
          Effect.withSpan("otel-event-flush.rpc"),
        ),
    }),
  ),
) {}

/** Worker that emits one Worker and one Durable Object OTLP event batch. */
export default class OtelEventFlushWorker extends Cloudflare.Worker<OtelEventFlushWorker>()(
  "OtelEventFlushWorker",
  {
    main: import.meta.url,
    env: {
      OTLP_EVENT_FLUSH_URL: Config.String("OTLP_EVENT_FLUSH_URL"),
      OTLP_EVENT_FLUSH_SHUTDOWN_TIMEOUT: Config.String(
        "OTLP_EVENT_FLUSH_SHUTDOWN_TIMEOUT",
      ).pipe(Config.withDefault("0 millis")),
    },
  },
  Effect.gen(function* () {
    const targetNamespace = yield* OtelEventFlushTarget;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/rpc")) {
          const pong = yield* targetNamespace.getByName("target").ping();
          return HttpServerResponse.text(`worker-saw:${pong}`);
        }
        const targetClient = Cloudflare.toHttpClient(
          targetNamespace.getByName("target"),
        );
        const response = yield* targetClient.execute(
          HttpClientRequest.get("http://otel-event-flush-target/"),
        );
        return HttpServerResponse.text(`worker-saw:${yield* response.text}`);
      }).pipe(Effect.withSpan("otel-event-flush.worker"), Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* Config.String("OTLP_EVENT_FLUSH_URL");
          const shutdownTimeout = yield* Config.Duration(
            "OTLP_EVENT_FLUSH_SHUTDOWN_TIMEOUT",
          ).pipe(Config.withDefault(Duration.zero));
          // Custom exporter selection is limited to the deadline regression.
          return Duration.toMillis(shutdownTimeout) === 0
            ? Telemetry.layerOtlp({
                traces: { url },
                serviceName: "otel-event-flush-test",
              })
            : Telemetry.layer(
                OtlpTracer.layer({
                  url,
                  resource: { serviceName: "otel-event-flush-test" },
                  exportInterval: "1 hour",
                  shutdownTimeout,
                }).pipe(Layer.provide(OtlpSerialization.layerJson)),
              );
        }),
      ),
    ),
  ),
) {}
