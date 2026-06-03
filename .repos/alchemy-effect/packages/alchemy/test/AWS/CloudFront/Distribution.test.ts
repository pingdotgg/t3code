import * as AWS from "@/AWS";
import { Distribution, OriginAccessControl } from "@/AWS/CloudFront";
import type { PolicyStatement } from "@/AWS/IAM/Policy";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

describe("AWS.CloudFront.Distribution", () => {
  test.provider.skipIf(!runLive)(
    "create and delete distribution for a private S3 origin",
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

            return {
              bucket,
              oac,
              distribution,
            };
          }),
        );

        const current = yield* cloudfront.getDistribution({
          Id: deployed.distribution.distributionId,
        });
        expect(current.Distribution?.Status).toEqual("Deployed");
        expect(current.Distribution?.DomainName).toEqual(
          deployed.distribution.domainName,
        );

        const control = yield* cloudfront.getOriginAccessControl({
          Id: deployed.oac.originAccessControlId,
        });
        expect(control.OriginAccessControl?.Id).toEqual(
          deployed.oac.originAccessControlId,
        );

        yield* S3.putObject({
          Bucket: deployed.bucket.bucketName,
          Key: "index.html",
          Body: "<html>ok</html>",
          ContentType: "text/html; charset=utf-8",
        });

        yield* stack.destroy();
        yield* assertDistributionDeleted(deployed.distribution.distributionId);
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
