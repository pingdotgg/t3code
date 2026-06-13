import * as AWS from "@/AWS";
import {
  CachePolicy,
  Distribution,
  KeyGroup,
  OriginAccessControl,
  OriginRequestPolicy,
  PublicKey,
  ResponseHeadersPolicy,
} from "@/AWS/CloudFront";
import type { PolicyStatement } from "@/AWS/IAM/Policy";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvTkfqkMHU8HMmIRKJaMl
IoD691g60aS15QlaP/DVkpuoeEp8JA8YDs5vQFu6HSIYCTQ7WwFx9oRvN08i7yXB
EHt3x7uZVpdkp6JBbjR9BGNsAVri6DZ0TJQ11zWeN3keqhnUdFhQjPwT+u4r6oKk
kNvkl7eU2nFK+UIaPlD+rA+AlYT0m7gSVcd9KaLf/UzBrtSy1dbXYDT4dHChMUVy
4gDsQ6D4u6lRAHY9jcKxlgEIM+O8ODKyzlbergv2EwhANG4P27DBeDhA/off3upM
TTVTGKZeoABtqM0ZiYq0cDgf8KUn9NPxSdnJ4+cbigLjJBPS93VYWzWX0HXlZpQ3
HQIDAQAB
-----END PUBLIC KEY-----
`;

describe("AWS.CloudFront smoke", () => {
  test.provider.skipIf(!runLive)(
    "deploy distribution wired to cache, origin request, and response headers policies alongside a key group",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("SmokeBucket", { forceDestroy: true });
            const oac = yield* OriginAccessControl("SmokeOac", {
              originType: "s3",
            });

            const cachePolicy = yield* CachePolicy("SmokeCachePolicy", {
              comment: "smoke",
              minTTL: 0,
              defaultTTL: 60,
              maxTTL: 86400,
              parametersInCacheKeyAndForwardedToOrigin: {
                EnableAcceptEncodingGzip: true,
                EnableAcceptEncodingBrotli: true,
                HeadersConfig: { HeaderBehavior: "none" },
                CookiesConfig: { CookieBehavior: "none" },
                QueryStringsConfig: { QueryStringBehavior: "none" },
              },
            });

            const originRequestPolicy = yield* OriginRequestPolicy(
              "SmokeOriginRequestPolicy",
              {
                comment: "smoke",
                headersConfig: { HeaderBehavior: "none" },
                cookiesConfig: { CookieBehavior: "none" },
                queryStringsConfig: { QueryStringBehavior: "all" },
              },
            );

            const responseHeadersPolicy = yield* ResponseHeadersPolicy(
              "SmokeResponseHeadersPolicy",
              {
                comment: "smoke",
                securityHeadersConfig: {
                  StrictTransportSecurity: {
                    AccessControlMaxAgeSec: 31536000,
                    IncludeSubdomains: true,
                    Preload: true,
                    Override: true,
                  },
                  ContentTypeOptions: { Override: true },
                  FrameOptions: { FrameOption: "DENY", Override: true },
                },
              },
            );

            const publicKey = yield* PublicKey("SmokeSigningKey", {
              encodedKey: SIGNING_PUBLIC_KEY,
              comment: "smoke signed-url key",
            });

            const keyGroup = yield* KeyGroup("SmokeSigningKeys", {
              comment: "smoke signed-url group",
              items: [publicKey.publicKeyId],
            });

            const distribution = yield* Distribution("SmokeDistribution", {
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
                cachePolicyId: cachePolicy.cachePolicyId,
                originRequestPolicyId:
                  originRequestPolicy.originRequestPolicyId,
                responseHeadersPolicyId:
                  responseHeadersPolicy.responseHeadersPolicyId,
              },
            });

            const statement: PolicyStatement = {
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: ["s3:GetObject"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": distribution.distributionArn as any,
                },
              },
            };

            yield* bucket.bind`Allow(${distribution}, CloudFront.Read(${bucket}))`(
              { policyStatements: [statement] },
            );

            return {
              bucket,
              oac,
              cachePolicy,
              originRequestPolicy,
              responseHeadersPolicy,
              publicKey,
              keyGroup,
              distribution,
            };
          }),
        );

        const dist = yield* cloudfront.getDistribution({
          Id: deployed.distribution.distributionId,
        });
        expect(dist.Distribution?.Status).toEqual("Deployed");

        const defaultBehavior =
          dist.Distribution?.DistributionConfig?.DefaultCacheBehavior;
        expect(defaultBehavior?.CachePolicyId).toEqual(
          deployed.cachePolicy.cachePolicyId,
        );
        expect(defaultBehavior?.OriginRequestPolicyId).toEqual(
          deployed.originRequestPolicy.originRequestPolicyId,
        );
        expect(defaultBehavior?.ResponseHeadersPolicyId).toEqual(
          deployed.responseHeadersPolicy.responseHeadersPolicyId,
        );

        const cachePolicy = yield* cloudfront.getCachePolicy({
          Id: deployed.cachePolicy.cachePolicyId,
        });
        expect(cachePolicy.CachePolicy?.Id).toEqual(
          deployed.cachePolicy.cachePolicyId,
        );

        const originRequestPolicy = yield* cloudfront.getOriginRequestPolicy({
          Id: deployed.originRequestPolicy.originRequestPolicyId,
        });
        expect(originRequestPolicy.OriginRequestPolicy?.Id).toEqual(
          deployed.originRequestPolicy.originRequestPolicyId,
        );

        const responseHeadersPolicy =
          yield* cloudfront.getResponseHeadersPolicy({
            Id: deployed.responseHeadersPolicy.responseHeadersPolicyId,
          });
        expect(responseHeadersPolicy.ResponseHeadersPolicy?.Id).toEqual(
          deployed.responseHeadersPolicy.responseHeadersPolicyId,
        );

        const keyGroup = yield* cloudfront.getKeyGroup({
          Id: deployed.keyGroup.keyGroupId,
        });
        expect(keyGroup.KeyGroup?.KeyGroupConfig?.Items).toEqual([
          deployed.publicKey.publicKeyId,
        ]);

        yield* stack.destroy();
        yield* assertDistributionDeleted(deployed.distribution.distributionId);
        yield* assertCachePolicyDeleted(deployed.cachePolicy.cachePolicyId);
        yield* assertOriginRequestPolicyDeleted(
          deployed.originRequestPolicy.originRequestPolicyId,
        );
        yield* assertResponseHeadersPolicyDeleted(
          deployed.responseHeadersPolicy.responseHeadersPolicyId,
        );
        yield* assertKeyGroupDeleted(deployed.keyGroup.keyGroupId);
        yield* assertPublicKeyDeleted(deployed.publicKey.publicKeyId);
      }),
    900_000,
  );
});

const retrying = (label: string) =>
  Effect.retry({
    while: (error: unknown) =>
      error instanceof Error && error.message === label,
    schedule: Schedule.fixed("10 seconds").pipe(
      Schedule.both(Schedule.recurs(60)),
    ),
  });

const assertDistributionDeleted = (id: string) =>
  cloudfront.getDistribution({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    retrying("DistributionStillExists"),
  );

const assertCachePolicyDeleted = (id: string) =>
  cloudfront.getCachePolicy({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("CachePolicyStillExists"))),
    Effect.catchTag("NoSuchCachePolicy", () => Effect.void),
    retrying("CachePolicyStillExists"),
  );

const assertOriginRequestPolicyDeleted = (id: string) =>
  cloudfront.getOriginRequestPolicy({ Id: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("OriginRequestPolicyStillExists")),
    ),
    Effect.catchTag("NoSuchOriginRequestPolicy", () => Effect.void),
    retrying("OriginRequestPolicyStillExists"),
  );

const assertResponseHeadersPolicyDeleted = (id: string) =>
  cloudfront.getResponseHeadersPolicy({ Id: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("ResponseHeadersPolicyStillExists")),
    ),
    Effect.catchTag("NoSuchResponseHeadersPolicy", () => Effect.void),
    retrying("ResponseHeadersPolicyStillExists"),
  );

const assertKeyGroupDeleted = (id: string) =>
  cloudfront.getKeyGroup({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("KeyGroupStillExists"))),
    Effect.catchTag("NoSuchResource", () => Effect.void),
    retrying("KeyGroupStillExists"),
  );

const assertPublicKeyDeleted = (id: string) =>
  cloudfront.getPublicKey({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("PublicKeyStillExists"))),
    Effect.catchTag("NoSuchPublicKey", () => Effect.void),
    retrying("PublicKeyStillExists"),
  );
