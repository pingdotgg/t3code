import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Config.string("OTLP_EVENT_FLUSH_URL").pipe(
          Effect.map((url) =>
            Telemetry.layerOtlp({
              traces: { url },
              serviceName: "otel-event-flush-test",
            }),
          ),
        ),
      ),
    ),
  ),
) {}
