import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * Lambda fixture for Telemetry.test.ts: exercises the `Telemetry.layerOtlp`
 * binding layer. Building it at deploy time binds the collector url
 * (resolved from the deployer's `COLLECTOR_URL` config, provided by the
 * test's ConfigProvider override) and the service name onto the Function;
 * at runtime the exporter reads them back per invocation.
 *
 * `GET /work` runs a child span and a log so the test can assert traces AND
 * logs arrive at the collector after the invocation scope flushes.
 *
 * The function times out after 3 s, with a 2 s margin (`timeoutMargin`), so
 * Lambda itself is configured for 5 s.
 *
 * `GET /slow` outlives the timeout inside a child span. At 3 s the runtime
 * interrupts it: the finalizer runs and logs, the child span ends with the
 * interruption, and the root span ends with
 * `AWS.Lambda.InvocationTimeoutError`. The invocation is then held until
 * Lambda's 5 s timeout, which Lambda reports as a timeout and which shuts
 * the sandbox down.
 *
 * `GET /late` finishes just inside the timeout. It is never interrupted.
 *
 * `GET /stuck` outlives the timeout and its finalizer hangs past Lambda's own
 * timeout. The backstop flush ships the root span — marked
 * `aws.lambda.timeout.imminent` — before Lambda kills the process.
 */
export class OtelTestFunction extends Lambda.Function<Lambda.Function>()("OtelTelemetryFunction") {}

export const OtelTestFunctionLive = OtelTestFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(3),
    timeoutMargin: Duration.seconds(2),
  },
  Effect.gen(function* () {
    const doWork = Effect.fn("lambda.child-span")(function* () {
      yield* Effect.log("lambda-work-log");
      return "lambda-did-work";
    });
    // The call that hangs: interrupted at the timeout, it ends its span and
    // runs its finalizer.
    const doSlowWork = Effect.fn("lambda.slow-span")(function* () {
      yield* Effect.log("lambda-slow-log");
      yield* Effect.sleep("60 seconds").pipe(Effect.ensuring(Effect.log("lambda-slow-finalizer")));
      return "never";
    });
    const doStuckWork = Effect.never.pipe(
      Effect.ensuring(Effect.sleep("60 seconds")),
      Effect.as("never"),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          const marker = yield* doWork();
          return yield* HttpServerResponse.json({ marker });
        }
        if (url.pathname === "/late") {
          yield* Effect.sleep("2500 millis");
          return yield* HttpServerResponse.json({ marker: "lambda-late-done" });
        }
        if (url.pathname === "/slow") {
          const marker = yield* doSlowWork();
          return yield* HttpServerResponse.json({ marker });
        }
        if (url.pathname === "/stuck") {
          const marker = yield* doStuckWork;
          return yield* HttpServerResponse.json({ marker });
        }
        // Readiness gate for the test: the collector's workers.dev URL
        // propagates per-PoP, so it can serve placeholder 404s to the
        // Lambda's region long after the test machine sees it. The test
        // polls this route until it reports 200 before asserting on
        // exported telemetry.
        if (url.pathname === "/probe") {
          const endpoint = yield* Config.String("COLLECTOR_URL").pipe(Effect.orDie);
          const result = yield* Effect.tryPromise(() =>
            fetch(`${endpoint}/v1/probe`, {
              method: "POST",
              body: JSON.stringify({ probe: true }),
            }).then(async (r) => ({
              status: r.status,
              body: (await r.text()).slice(0, 200),
            })),
          ).pipe(Effect.catchCause((cause) => Effect.succeed({ status: -1, body: String(cause) })));
          return yield* HttpServerResponse.json(result);
        }
        return HttpServerResponse.text("otel-lambda-ok");
      }),
    };
  }).pipe(
    // The telemetry binding layer, composed like any other binding: the
    // collector url resolves once at deploy time and binds onto the
    // Function; nothing telemetry-specific appears in handler code.
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* Config.String("COLLECTOR_URL");
          return Telemetry.layerOtlp({ url, serviceName: "otel-lambda-test" });
        }),
      ),
    ),
  ),
);

export default OtelTestFunctionLive;
