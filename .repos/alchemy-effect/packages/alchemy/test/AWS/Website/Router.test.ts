import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// slow AF
describe.skip("AWS.Website.Router", () => {
  test.provider(
    "create router with static-site attached via KV routing",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("Router", {
              invalidation: {
                paths: "all",
                wait: true,
              },
            });

            const site = yield* AWS.Website.StaticSite("DocsSite", {
              path: "examples/aws-static-site/site",
              forceDestroy: true,
              router: {
                instance: {
                  kvStoreArn: router.kvStoreArn,
                  kvNamespace: router.kvNamespace,
                  distributionId: router.distributionId,
                  url: router.url,
                },
              },
            });

            return {
              site,
              router,
            };
          }),
        );

        expect(deployed.router.distribution.distributionId).toBeDefined();
        expect(deployed.router.kvStoreArn).toBeDefined();

        const config = yield* cloudfront.getDistributionConfig({
          Id: deployed.router.distribution.distributionId,
        });
        expect(
          config.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations
            ?.Quantity,
        ).toBeGreaterThanOrEqual(1);

        yield* stack.destroy();
        yield* assertDistributionDeleted(
          deployed.router.distribution.distributionId,
        );
      }),
    { timeout: 600_000 },
  );
});

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );
