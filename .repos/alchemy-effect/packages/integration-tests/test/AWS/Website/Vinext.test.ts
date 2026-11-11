import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime.
const runLive = !process.env.FAST;

// Built in place: vinext and its RSC toolchain resolve only from the
// example's own node_modules (build output is gitignored there).
const rootDir = pathe.resolve(import.meta.dirname, "../../../../../examples/aws-website-vinext");

const memo = {
  include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
};

describe.skipIf(!runLive)(
  "AWS.Website.Vinext",
  { tags: ["provider:aws", "provider:aws:cloudfront", "provider:aws:website", "live"] },
  () => {
    test.provider(
      "deploys App Router SSR on a Lambda Web Function with the S3 data cache",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* AWS.Website.Vinext("VinextSite", {
                rootDir,
                memo,
                forceDestroy: true,
                invalidation: { paths: "all", wait: true },
                env: { GREETING: "Hello from vinext on a Web Function!" },
              });
              return { site };
            }),
          );

          const url = deployed.site.url! as string;
          // The server is a Lambda Web Function (the default).
          expect(deployed.site.serverUrl).toContain(".lambda-web.");

          // Directly from the Web Function, then through CloudFront.
          yield* expectUrlContains(`${deployed.site.serverUrl!}`, "Hello from vinext on AWS!", {
            timeout: "120 seconds",
            label: "SSR direct from the Web Function",
          });
          yield* expectUrlContains(`${url}/`, "Hello from vinext on AWS!", {
            timeout: "180 seconds",
            label: "SSR page",
          });
          // A route handler reading the server's environment.
          yield* expectUrlContains(
            `${url}/api/hello?name=Alchemy`,
            "Hello from vinext on a Web Function!",
            { label: "route handler env" },
          );

          // The data cache writes to its S3 bucket from the Web Function.
          const cacheBucket = deployed.site.cacheBucket!.bucketName;
          const cached = yield* S3.listObjectsV2({ Bucket: cacheBucket }).pipe(
            Effect.map((r) => r.KeyCount ?? 0),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (count) => count > 0,
              times: 20,
            }),
          );
          expect(cached).toBeGreaterThan(0);

          const distributionId = deployed.site.distribution!.distributionId;
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }),
      { timeout: 2_400_000 },
    );
  },
);

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error) => error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
    }),
  );
