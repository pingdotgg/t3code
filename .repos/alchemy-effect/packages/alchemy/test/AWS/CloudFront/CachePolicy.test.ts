import * as AWS from "@/AWS";
import { CachePolicy } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.CloudFront.CachePolicy", () => {
  test.provider(
    "create, update, and delete a cache policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CachePolicy("ApiCachePolicy", {
              comment: "initial",
              minTTL: 0,
              defaultTTL: "60 seconds",
              maxTTL: "1 hour",
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
              defaultTTL: "120 seconds",
              maxTTL: "1 day",
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

        // Control-plane reads are eventually consistent — poll until the
        // update is visible, then assert the exact wire values.
        const after = yield* cloudfront
          .getCachePolicy({ Id: updated.cachePolicyId })
          .pipe(
            Effect.repeat({
              schedule: Schedule.fixed("2 seconds"),
              until: (r) =>
                r.CachePolicy?.CachePolicyConfig?.Comment === "updated",
              times: 15,
            }),
          );
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

  test.provider(
    "list enumerates the deployed cache policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* CachePolicy("ListCachePolicy", {
              comment: "list",
              minTTL: 0,
              defaultTTL: "60 seconds",
              maxTTL: "1 hour",
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

        const provider = yield* Provider.findProvider(CachePolicy);
        const all = yield* provider.list();

        expect(
          all.some((p) => p.cachePolicyId === deployed.cachePolicyId),
        ).toBe(true);

        yield* stack.destroy();
        yield* assertCachePolicyDeleted(deployed.cachePolicyId);
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
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
