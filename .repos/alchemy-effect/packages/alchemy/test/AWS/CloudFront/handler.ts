import * as CloudFront from "@/AWS/CloudFront";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class CloudFrontTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudFrontTestFunction",
) {}

export default CloudFrontTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("InvalidationOriginBucket", {
      forceDestroy: true,
    });
    const distribution = yield* CloudFront.Distribution("TestDistribution", {
      // Deterministic marker so the test can find this distribution
      // out-of-band via listDistributions.
      comment: "alchemy-cf-bindings-fixture",
      origins: [
        {
          id: "origin",
          domainName: bucket.bucketRegionalDomainName,
          s3Origin: true,
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: "origin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        minTtl: 0,
        forwardedValues: {
          QueryString: false,
          Cookies: { Forward: "none" },
        },
      },
    });

    const createInvalidation =
      yield* CloudFront.CreateInvalidation(distribution);
    const getInvalidation = yield* CloudFront.GetInvalidation(distribution);
    const listInvalidations = yield* CloudFront.ListInvalidations(distribution);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/invalidate") {
          const body = (yield* request.json) as unknown as {
            callerReference: string;
            paths: string[];
          };
          const response = yield* createInvalidation({
            InvalidationBatch: {
              CallerReference: body.callerReference,
              Paths: {
                Quantity: body.paths.length,
                Items: body.paths,
              },
            },
          });
          return yield* HttpServerResponse.json({
            invalidationId: response.Invalidation?.Id,
            status: response.Invalidation?.Status,
          });
        }

        if (request.method === "GET" && pathname === "/invalidation") {
          const id = url.searchParams.get("id")!;
          const response = yield* getInvalidation({ Id: id });
          return yield* HttpServerResponse.json({
            invalidationId: response.Invalidation?.Id,
            status: response.Invalidation?.Status,
          });
        }

        if (request.method === "GET" && pathname === "/invalidations") {
          const response = yield* listInvalidations({});
          return yield* HttpServerResponse.json({
            invalidationIds: (response.InvalidationList?.Items ?? []).map(
              (item) => item.Id,
            ),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudFront.CreateInvalidationHttp,
        CloudFront.GetInvalidationHttp,
        CloudFront.ListInvalidationsHttp,
      ),
    ),
  ),
);
