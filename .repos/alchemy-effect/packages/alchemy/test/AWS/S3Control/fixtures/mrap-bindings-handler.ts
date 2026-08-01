import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Gated (AWS_TEST_SLOW) fixture: a single-region Multi-Region Access Point
// plus a Lambda that exercises the two MRAP failover bindings —
// GetMultiRegionAccessPointRoutes and SubmitMultiRegionAccessPointRoutes.
// MRAP provisioning is asynchronous and takes 10-20 minutes, hence the gate.
export class S3ControlMrapBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "S3ControlMrapBindingsFunction",
) {}

export class BoundMrap extends Context.Service<
  BoundMrap,
  { mrap: AWS.S3Control.MultiRegionAccessPoint }
>()("BoundMrap") {}

export const BoundMrapLive = Layer.effect(
  BoundMrap,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("S3ControlMrapBucket", {});
    const mrap = yield* AWS.S3Control.MultiRegionAccessPoint(
      "S3ControlMrapBindingsMrap",
      { regions: [{ bucket: bucket.bucketName }] },
    );
    return { mrap };
  }),
);

export default S3ControlMrapBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const { mrap } = yield* BoundMrap;

    const getRoutes =
      yield* AWS.S3Control.GetMultiRegionAccessPointRoutes(mrap);
    const submitRoutes =
      yield* AWS.S3Control.SubmitMultiRegionAccessPointRoutes(mrap);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/routes") {
          const { Routes } = yield* getRoutes();
          return yield* HttpServerResponse.json({
            mrapName: mrap.multiRegionAccessPointName,
            routes: (Routes ?? []).map((r) => ({
              region: r.Region,
              trafficDialPercentage: r.TrafficDialPercentage,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/dial-100") {
          // Re-submit every route at 100% — an idempotent write that proves
          // the Submit binding end-to-end without shifting real traffic.
          const { Routes } = yield* getRoutes();
          yield* submitRoutes({
            RouteUpdates: (Routes ?? []).map((r) => ({
              Region: r.Region,
              TrafficDialPercentage: 100,
            })),
          });
          const after = yield* getRoutes();
          return yield* HttpServerResponse.json({
            routes: (after.Routes ?? []).map((r) => ({
              region: r.Region,
              trafficDialPercentage: r.TrafficDialPercentage,
            })),
          });
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
        AWS.S3Control.GetMultiRegionAccessPointRoutesHttp,
        AWS.S3Control.SubmitMultiRegionAccessPointRoutesHttp,
        BoundMrapLive,
      ),
    ),
  ),
);
