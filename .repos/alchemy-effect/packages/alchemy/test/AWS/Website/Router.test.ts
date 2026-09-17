import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min), so the full Router lifecycle exceeds any sane test budget.
// Skipped under --fast (FAST=1) (same gate as the
// AWS.CloudFront suites).
const runLive = !process.env.FAST;

describe.skipIf(!runLive)("AWS.Website.Router", () => {
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
              path: fixtureDir,
              forceDestroy: true,
              domain: {
                router,
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

        // urls contract (cloudfront-default arm): a router without a
        // domain serves only at the distribution's own URL (its CloudFront
        // default domain live, a local edge port under the emulator), and
        // `url` is always `urls[0]`.
        expect(deployed.router.urls).toEqual([
          deployed.router.distribution.url,
        ]);
        expect(deployed.router.url).toBe(deployed.router.urls[0]);
        // A path-only attached site inherits the router's primary URL.
        expect(deployed.site.urls).toEqual([deployed.router.url]);
        expect(deployed.site.url).toBe(deployed.site.urls[0]);

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
    // Create waits for Status === "Deployed" (~5 min) and destroy is
    // disable -> wait -> delete (~5-15 min more): 600s was measured too
    // small — the run died mid-destroy with green assertions.
    // CloudFront full lifecycle (create + KV-routed assertions + disable +
    // delete) measures ~6m with bounded polls; generous headroom for
    // propagation variance. If this ever times out mid-destroy again,
    // suspect a hung poll first (see the Effect.timeout guards in
    // Distribution.ts), not CloudFront.
    { timeout: 1_500_000 },
  );
});

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );
