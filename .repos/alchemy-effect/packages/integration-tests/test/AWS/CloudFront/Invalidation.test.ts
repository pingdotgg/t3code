import * as AWS from "@alchemy.run/aws";
import { Distribution, OriginAccessControl } from "@alchemy.run/aws/CloudFront";
import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import { Bucket } from "@alchemy.run/aws/S3";
import { AssetDeployment } from "@alchemy.run/aws/Website/AssetDeployment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create invalidation with explicit paths and wait for completion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("WebsiteBucket", { forceDestroy: true });
          const oac = yield* OriginAccessControl("WebsiteOac", { originType: "s3" });
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
              forwardedValues: { QueryString: false, Cookies: { Forward: "none" } },
            },
          });

          const statement: PolicyStatement = {
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: ["s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
            Condition: { StringEquals: { "AWS:SourceArn": distribution.distributionArn as any } },
          };

          yield* bucket.bind`Allow(${distribution}, CloudFront.Read(${bucket}))`({
            policyStatements: [statement],
          });

          const invalidation = yield* AWS.CloudFront.Invalidation("InvalidateDocs", {
            distributionId: distribution.distributionId,
            version: "v2",
            wait: true,
            paths: ["/index.html", "/docs/*"],
          });

          return { bucket, distribution, invalidation };
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
      // CloudFront returns invalidation paths in arbitrary order.
      expect([...(current.Invalidation?.InvalidationBatch?.Paths?.Items ?? [])].sort()).toEqual([
        "/docs/*",
        "/index.html",
      ]);

      yield* stack.destroy();
      yield* assertDistributionDeleted(deployed.distribution.distributionId);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:cloudfront",
      "provider:aws:iam",
      "provider:aws:s3",
      "live",
    ],
    timeout: 600_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "issues a new invalidation when an upstream content version changes",
  (stack) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const site = (version: "v1" | "v2") =>
        path.join(import.meta.dirname, "fixtures", `invalidation-site-${version}`);

      // `version` comes from an AssetDeployment, so on a content change it is
      // unresolved at plan time and the Invalidation plans as an update rather
      // than a replace — the documented "invalidate on content change" setup.
      const deploySite = (sourcePath: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("SiteBucket", { forceDestroy: true });
            const distribution = yield* Distribution("SiteDistribution", {
              origins: [
                {
                  id: "site",
                  domainName: bucket.bucketRegionalDomainName,
                  s3Origin: true,
                },
              ],
              defaultCacheBehavior: {
                targetOriginId: "site",
                viewerProtocolPolicy: "redirect-to-https",
                allowedMethods: ["GET", "HEAD"],
                cachedMethods: ["GET", "HEAD"],
                forwardedValues: {
                  QueryString: false,
                  Cookies: { Forward: "none" },
                },
              },
            });
            const files = yield* AssetDeployment("SiteFiles", {
              bucket,
              sourcePath,
            });
            const invalidation = yield* AWS.CloudFront.Invalidation("SiteInvalidation", {
              distributionId: distribution.distributionId,
              version: files.version,
            });
            return { distribution, files, invalidation };
          }),
        );

      yield* stack.destroy();

      const first = yield* deploySite(site("v1"));
      expect(first.invalidation.version).toEqual(first.files.version);

      const second = yield* deploySite(site("v2"));
      expect(second.files.version).not.toEqual(first.files.version);
      expect(second.invalidation.version).toEqual(second.files.version);
      expect(second.invalidation.invalidationId).not.toEqual(first.invalidation.invalidationId);

      const issued = yield* cloudfront.getInvalidation({
        DistributionId: second.distribution.distributionId,
        Id: second.invalidation.invalidationId,
      });
      expect(issued.Invalidation?.InvalidationBatch?.CallerReference).toEqual(second.files.version);

      yield* stack.destroy();
      yield* assertDistributionDeleted(second.distribution.distributionId);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:cloudfront",
      "provider:aws:s3",
      "provider:aws:website",
      "live",
    ],
    timeout: 600_000,
  },
);

test.provider(
  "list returns [] for the non-listable ephemeral invalidation",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AWS.CloudFront.Invalidation);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:aws:cloudfront", "live"] },
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
