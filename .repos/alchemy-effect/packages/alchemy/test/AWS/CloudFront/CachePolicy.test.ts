import * as AWS from "@/AWS";
import { CachePolicy } from "@/AWS/CloudFront";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

describe("AWS.CloudFront.CachePolicy", () => {
  test.provider.skipIf(!runLive)(
    "create, update, and delete a cache policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CachePolicy("ApiCachePolicy", {
              comment: "initial",
              minTTL: 0,
              defaultTTL: 60,
              maxTTL: 3600,
              parametersInCacheKeyAndForwardedToOrigin: {
                EnableAcceptEncodingGzip: true,
                EnableAcceptEncodingBrotli: true,
                HeadersConfig: {
                  HeaderBehavior: "whitelist",
                  Headers: { Quantity: 1, Items: ["Authorization"] },
                },
                CookiesConfig: { CookieBehavior: "none" },
                QueryStringsConfig: { QueryStringBehavior: "all" },
              },
            });
          }),
        );

        const initial = yield* cloudfront.getCachePolicy({
          Id: created.cachePolicyId,
        });
        expect(initial.CachePolicy?.Id).toEqual(created.cachePolicyId);
        expect(initial.CachePolicy?.CachePolicyConfig?.Comment).toEqual(
          "initial",
        );
        expect(initial.CachePolicy?.CachePolicyConfig?.DefaultTTL).toEqual(60);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CachePolicy("ApiCachePolicy", {
              comment: "updated",
              minTTL: 0,
              defaultTTL: 120,
              maxTTL: 86400,
              parametersInCacheKeyAndForwardedToOrigin: {
                EnableAcceptEncodingGzip: true,
                EnableAcceptEncodingBrotli: true,
                HeadersConfig: { HeaderBehavior: "none" },
                CookiesConfig: { CookieBehavior: "none" },
                QueryStringsConfig: { QueryStringBehavior: "none" },
              },
            });
          }),
        );

        expect(updated.cachePolicyId).toEqual(created.cachePolicyId);

        const after = yield* cloudfront.getCachePolicy({
          Id: updated.cachePolicyId,
        });
        expect(after.CachePolicy?.CachePolicyConfig?.Comment).toEqual(
          "updated",
        );
        expect(after.CachePolicy?.CachePolicyConfig?.DefaultTTL).toEqual(120);
        expect(after.CachePolicy?.CachePolicyConfig?.MaxTTL).toEqual(86400);

        yield* stack.destroy();
        yield* assertCachePolicyDeleted(updated.cachePolicyId);
      }),
    { timeout: 300_000 },
  );
});

const assertCachePolicyDeleted = (id: string) =>
  cloudfront.getCachePolicy({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("CachePolicyStillExists"))),
    Effect.catchTag("NoSuchCachePolicy", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "CachePolicyStillExists",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
