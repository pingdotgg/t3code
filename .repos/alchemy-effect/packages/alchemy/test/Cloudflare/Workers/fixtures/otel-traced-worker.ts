import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker exercising the built-in `Telemetry.layerOtlp` binding
 * layer: building it at deploy time binds the collector url (resolved from
 * the deployer's `COLLECTOR_URL` config, provided by Telemetry.test.ts
 * after the collector deploys) and the service name onto the Worker; at
 * runtime the exporter reads them back per request.
 *
 * `GET /work` runs a child span and a log so the test can assert traces
 * AND logs arrive at the collector after the request scope flushes.
 */
export default class OtelTracedWorker extends Cloudflare.Worker<OtelTracedWorker>()(
  "OtelTracedWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const doWork = Effect.fn("test.child-span")(function* () {
      yield* Effect.log("did-work-log");
      return "did-work";
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          const result = yield* doWork();
          return yield* HttpServerResponse.json({ marker: result });
        }
        // Readiness gate for the test: OTLP export goes worker->worker, so
        // the collector's custom domain must be reachable *from inside a
        // Worker* (workers.dev would be blocked with error 1042). The test
        // polls this route until it reports 200 before asserting on
        // exported telemetry.
        if (url.pathname === "/probe") {
          const endpoint = yield* Config.string("COLLECTOR_URL").pipe(
            Effect.orDie,
          );
          const result = yield* Effect.tryPromise(() =>
            fetch(`${endpoint}/v1/traces`, {
              method: "POST",
              body: JSON.stringify({ probe: true }),
            }).then(async (r) => ({
              status: r.status,
              body: (await r.text()).slice(0, 200),
            })),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({ status: -1, body: String(cause) }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }
        return HttpServerResponse.text("otel-traced-ok");
      }),
    };
  }).pipe(
    // The telemetry binding layers, composed like any other binding: the
    // collector url is resolved once at deploy time and bound onto the
    // Worker; nothing telemetry-specific appears in handler code. Two
    // merged otlp layers = two destinations — spans are serialized once
    // and fanned out to both (the second lands under `/v1/second-traces`,
    // which the collector records as signal "second-traces").
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* Config.string("COLLECTOR_URL");
          return Layer.mergeAll(
            Telemetry.layerOtlp({ url, serviceName: "otel-traced-test" }),
            Telemetry.layerOtlp({ traces: { url: `${url}/v1/second-traces` } }),
          );
        }),
      ),
    ),
  ),
) {}
