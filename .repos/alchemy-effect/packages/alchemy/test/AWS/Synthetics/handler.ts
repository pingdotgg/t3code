import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3";
import * as Synthetics from "@/AWS/Synthetics";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Trivial heartbeat script — a single successful step, no page load.
const HEARTBEAT_SCRIPT = `
const synthetics = require("Synthetics");
exports.handler = async function () {
  return await synthetics.executeStep("heartbeat", async function () {});
};
`;

export class SyntheticsBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "SyntheticsBindingsFunction",
) {}

export default SyntheticsBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const bucket = yield* Bucket("SynthBindingsArtifacts", {
      forceDestroy: true,
    });
    // `rate(0 minute)` = run exactly once when started, so /start does not
    // leave a continuously-running canary behind.
    const canary = yield* Synthetics.Canary("BindingsCanary", {
      script: HEARTBEAT_SCRIPT,
      artifactS3Location: Output.interpolate`s3://${bucket.bucketName}/bindings`,
      schedule: { expression: "rate(0 minute)" },
      runConfig: { timeout: "60 seconds" },
      successRetentionPeriod: "1 day",
      failureRetentionPeriod: "1 day",
    });

    // Event source: subscribe the host to this canary's status/run events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* Synthetics.consumeCanaryEvents(
      { canaryNames: [canary.canaryName] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `synthetics event: ${event["detail-type"]} for ${event.detail["canary-name"]}`,
          ),
        ),
    );

    const bound = {
      getCanary: yield* Synthetics.GetCanary(canary),
      getCanaryRuns: yield* Synthetics.GetCanaryRuns(canary),
      startCanary: yield* Synthetics.StartCanary(canary),
      stopCanary: yield* Synthetics.StopCanary(canary),
      describeCanariesLastRun: yield* Synthetics.DescribeCanariesLastRun(),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Canary-scoped read — the canary name is injected.
        if (request.method === "GET" && pathname === "/canary") {
          const result = yield* bound.getCanary().pipe(
            Effect.map((r) => ({
              tag: "ok",
              state: r.Canary?.Status?.State,
            })),
            Effect.catch((e) =>
              Effect.succeed({ tag: e._tag, state: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/runs") {
          const result = yield* bound.getCanaryRuns({ MaxResults: 10 }).pipe(
            Effect.map((r) => ({
              tag: "ok",
              count: (r.CanaryRuns ?? []).length,
            })),
            Effect.catch((e) =>
              Effect.succeed({ tag: e._tag, count: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Account-level read across every canary.
        if (request.method === "GET" && pathname === "/last-run") {
          const result = yield* bound.describeCanariesLastRun().pipe(
            Effect.map((r) => ({
              tag: "ok",
              count: (r.CanariesLastRun ?? []).length,
            })),
            Effect.catch((e) =>
              Effect.succeed({ tag: e._tag, count: undefined }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Control plane: start the (READY) canary / stop it. A typed
        // ConflictException still proves the grant round-tripped.
        if (request.method === "GET" && pathname === "/start") {
          const tag = yield* bound.startCanary().pipe(
            Effect.map(() => "ok"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/stop") {
          const tag = yield* bound.stopCanary().pipe(
            Effect.map(() => "ok"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Synthetics.GetCanaryHttp,
        Synthetics.GetCanaryRunsHttp,
        Synthetics.StartCanaryHttp,
        Synthetics.StopCanaryHttp,
        Synthetics.DescribeCanariesLastRunHttp,
      ),
    ),
  ),
);
