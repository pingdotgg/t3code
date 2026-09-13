import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Otlp from "effect/unstable/observability/Otlp";

/**
 * Effect-native Worker exercising the *custom exporter* telemetry path:
 * `Effect.provide(Telemetry.layer(...))` on the Worker's init Effect
 * replaces the env-driven default with a hand-built OTLP Layer. The Layer
 * is still built once per event into the request scope, so its exporters
 * flush when the request scope finalizes.
 */
export default class OtelCustomWorker extends Cloudflare.Worker<OtelCustomWorker>()(
  "OtelCustomWorker",
  {
    main: import.meta.url,
    env: {
      // Config key must equal the env key — the props re-execute inside
      // the deployed isolate and re-read the Config from the bound var.
      COLLECTOR_URL: Config.string("COLLECTOR_URL"),
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          yield* Effect.log("custom-work-log").pipe(
            Effect.withSpan("custom.child-span"),
          );
          return yield* HttpServerResponse.json({ marker: "custom-did-work" });
        }
        return HttpServerResponse.text("otel-custom-ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Telemetry.layer(
        Layer.unwrap(
          Effect.gen(function* () {
            const baseUrl = yield* Config.string("COLLECTOR_URL");
            return Otlp.layerJson({
              baseUrl,
              resource: { serviceName: "otel-custom-test" },
            });
          }),
        ),
      ),
    ),
  ),
) {}
