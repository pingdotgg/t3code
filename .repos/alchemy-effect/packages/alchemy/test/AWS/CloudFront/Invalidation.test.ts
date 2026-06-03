import * as AWS from "@/AWS";
import { Distribution, OriginAccessControl } from "@/AWS/CloudFront";
import type { PolicyStatement } from "@/AWS/IAM/Policy";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS !== "true")(
  "create invalidation with explicit paths and wait for completion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("WebsiteBucket", {
            forceDestroy: true,
          });
          const oac = yield* OriginAccessControl("WebsiteOac", {
            originType: "s3",
          });
          const distribution = yield* Distribution("WebsiteDistribution", {
            origins: [
              {
                id: "site",
                domainName: bucket.bucketRegionalDomainName,
                s3Origin: true,
                originAccessControlId: oac.originAccessControlId,
              },
            ],
            defaultRootObject: "index.html",
            defaultCacheBehavior: {
              targetOriginId: "site",
              viewerProtocolPolicy: "redirect-to-https",
              compress: true,
              allowedMethods: ["GET", "HEAD"],
              cachedMethods: ["GET", "HEAD"],
              forwardedValues: {
                QueryString: false,
                Cookies: {
                  Forward: "none",
                },
              },
            },
          });

          const statement: PolicyStatement = {
            Effect: "Allow",
            Principal: {
              Service: "cloudfront.amazonaws.com",
            },
            Action: ["s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
            Condition: {
              StringEquals: {
                "AWS:SourceArn": distribution.distributionArn as any,
              },
            },
          };

          yield* bucket.bind`Allow(${distribution}, CloudFront.Read(${bucket}))`(
            {
              policyStatements: [statement],
            },
          );

          const invalidation = yield* AWS.CloudFront.Invalidation(
            "InvalidateDocs",
            {
              distributionId: distribution.distributionId,
              version: "v2",
              wait: true,
              paths: ["/index.html", "/docs/*"],
            },
          );

          return {
            bucket,
            distribution,
            invalidation,
          };
        }),
      );

      yield* S3.putObject({
        Bucket: deployed.bucket.bucketName,
        Key: "index.html",
        Body: "<html>ok</html>",
        ContentType: "text/html; charset=utf-8",
      });

      const current = yield* cloudfront.getInvalidation({
        DistributionId: deployed.distribution.distributionId,
        Id: deployed.invalidation.invalidationId,
      });
      expect(current.Invalidation?.Status).toEqual("Completed");
      expect(current.Invalidation?.InvalidationBatch?.Paths?.Items).toEqual([
        "/index.html",
        "/docs/*",
      ]);

      yield* stack.destroy();
      yield* assertDistributionDeleted(deployed.distribution.distributionId);
    }),
  { timeout: 600_000 },
);

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
