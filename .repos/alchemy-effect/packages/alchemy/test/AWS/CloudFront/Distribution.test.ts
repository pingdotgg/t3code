import * as AWS from "@/AWS";
import { Distribution, OriginAccessControl } from "@/AWS/CloudFront";
import type { PolicyStatement } from "@/AWS/IAM/Policy";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
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
                  // Duration.Input → wire whole-seconds conversion under test.
                  connectionTimeout: "5 seconds",
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
                // Duration.Input → wire whole-seconds conversion under test.
                minTtl: 0,
                defaultTtl: "5 minutes",
                maxTtl: "1 hour",
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
        // Duration.Input props reached the wire as whole seconds.
        const config = current.Distribution?.DistributionConfig;
        expect(config?.Origins?.Items?.[0]?.ConnectionTimeout).toEqual(5);
        expect(config?.DefaultCacheBehavior?.MinTTL).toEqual(0);
        expect(config?.DefaultCacheBehavior?.DefaultTTL).toEqual(300);
        expect(config?.DefaultCacheBehavior?.MaxTTL).toEqual(3600);

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

  // Fast probe (read-only): CloudFront `list()` exhaustively paginates
  // `listDistributions` and resolves each summary to the full `read`-shaped
  // Attributes. This runs without deploying anything (distribution create +
  // disable-before-delete exceeds CI budget — see the gated full test below),
  // so it verifies the live list op cheaply.
  test.provider(
    "list enumerates account distributions",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(Distribution);
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const item of all) {
          expect(item.distributionId).toBeDefined();
          expect(item.distributionArn).toBeDefined();
          expect(item.domainName).toBeDefined();
        }
      }),
    // Hydrating every distribution in a busy account (3 read calls each)
    // under CloudFront's aggressive read throttle takes a while even with
    // the provider's bounded retry — give it ample headroom.
    { timeout: 300_000 },
  );

  // Full lifecycle: deploy a real distribution, assert it shows up in the
  // enumerated result, then tear it down. Gated behind the same slow-test env
  // flag as the create/delete case because distribution provisioning +
  // disable-before-delete can take many minutes.
  test.provider.skipIf(!runLive)(
    "list includes a freshly deployed distribution",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("ListWebsiteBucket", {
              forceDestroy: true,
            });
            const oac = yield* OriginAccessControl("ListWebsiteOac", {
              originType: "s3",
            });
            return yield* Distribution("ListWebsiteDistribution", {
              origins: [
                {
                  id: "site",
                  domainName: bucket.bucketRegionalDomainName,
                  s3Origin: true,
                  originAccessControlId: oac.originAccessControlId,
                },
              ],
              defaultCacheBehavior: {
                targetOriginId: "site",
                viewerProtocolPolicy: "redirect-to-https",
                compress: true,
              },
            });
          }),
        );

        const provider = yield* Provider.findProvider(Distribution);
        const all = yield* provider.list();

        expect(
          all.some((d) => d.distributionId === deployed.distributionId),
        ).toBe(true);

        yield* stack.destroy();
        yield* assertDistributionDeleted(deployed.distributionId);
      }),
    { timeout: 600_000 },
  );
  // Exercises the newly-exposed config gaps: geo restriction + custom error
  // responses. Creates with a whitelist + a custom 404, updates the geo
  // restriction to `none`, and asserts both round-trip via getDistributionConfig.
  test.provider.skipIf(!runLive)(
    "geo restriction and custom error responses round-trip",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("GeoBucket", { forceDestroy: true });
            const oac = yield* OriginAccessControl("GeoOac", {
              originType: "s3",
            });
            const distribution = yield* Distribution("GeoDistribution", {
              origins: [
                {
                  id: "site",
                  domainName: bucket.bucketRegionalDomainName,
                  s3Origin: true,
                  originAccessControlId: oac.originAccessControlId,
                },
              ],
              defaultCacheBehavior: {
                targetOriginId: "site",
                viewerProtocolPolicy: "redirect-to-https",
                compress: true,
              },
              geoRestriction: {
                restrictionType: "whitelist",
                locations: ["US", "CA"],
              },
              customErrorResponses: [
                {
                  ErrorCode: 404,
                  ResponseCode: "404",
                  ResponsePagePath: "/404.html",
                  ErrorCachingMinTTL: 10,
                },
              ],
            });
            return { distribution };
          }),
        );

        const created = yield* cloudfront.getDistributionConfig({
          Id: deployed.distribution.distributionId,
        });
        expect(
          created.DistributionConfig?.Restrictions?.GeoRestriction
            .RestrictionType,
        ).toEqual("whitelist");
        expect(
          created.DistributionConfig?.Restrictions?.GeoRestriction.Items?.sort(),
        ).toEqual(["CA", "US"]);
        expect(
          created.DistributionConfig?.CustomErrorResponses?.Items?.[0]
            .ErrorCode,
        ).toEqual(404);

        // Update: drop the geo restriction.
        yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("GeoBucket", { forceDestroy: true });
            const oac = yield* OriginAccessControl("GeoOac", {
              originType: "s3",
            });
            return yield* Distribution("GeoDistribution", {
              origins: [
                {
                  id: "site",
                  domainName: bucket.bucketRegionalDomainName,
                  s3Origin: true,
                  originAccessControlId: oac.originAccessControlId,
                },
              ],
              defaultCacheBehavior: {
                targetOriginId: "site",
                viewerProtocolPolicy: "redirect-to-https",
                compress: true,
              },
              geoRestriction: { restrictionType: "none" },
            });
          }),
        );

        const updated = yield* cloudfront.getDistributionConfig({
          Id: deployed.distribution.distributionId,
        });
        expect(
          updated.DistributionConfig?.Restrictions?.GeoRestriction
            .RestrictionType,
        ).toEqual("none");

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
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );
