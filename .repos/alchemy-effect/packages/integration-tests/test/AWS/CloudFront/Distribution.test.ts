import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import {
  Distribution,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
  OriginAccessControl,
} from "@alchemy.run/aws/CloudFront";
import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import { Bucket } from "@alchemy.run/aws/S3";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = !process.env.FAST;
// Web Functions are live-only; the Floci sweep (`ALCHEMY_TEST_DEV=1`) points
// every AWS client at the emulator, which does not emulate them.
const runWebFunctions = runLive && process.env.ALCHEMY_TEST_DEV !== "1";

const webFunctionMain = fileURLToPath(new URL("./fixtures/web-function.ts", import.meta.url));

// CloudFront itself bounds these lifecycles: a create waits ~5 min for
// `Deployed`, a config update up to several more, and delete must disable
// the distribution and wait for `Deployed` again (~3–5 min) before the
// DeleteDistribution call. Under a loaded full-suite run create+update+delete
// measured ~570s — right at the old 600s cap, so attempts timed out
// mid-teardown. 15 min covers the platform floor with headroom.
const DEPLOY_DELETE_TIMEOUT = 900_000;

describe(
  "AWS.CloudFront.Distribution",
  { tags: ["provider:aws", "provider:aws:cloudfront", "live"] },
  () => {
    test.provider.skipIf(!runLive)(
      "create and delete distribution for a private S3 origin",
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
                  forwardedValues: { QueryString: false, Cookies: { Forward: "none" } },
                  // Duration.Input → wire whole-seconds conversion under test.
                  minTtl: 0,
                  defaultTtl: "5 minutes",
                  maxTtl: "1 hour",
                },
              });

              const statement: PolicyStatement = {
                Effect: "Allow",
                Principal: { Service: "cloudfront.amazonaws.com" },
                Action: ["s3:GetObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
                Condition: {
                  StringEquals: { "AWS:SourceArn": distribution.distributionArn as any },
                },
              };

              yield* bucket.bind`Allow(${distribution}, CloudFront.Read(${bucket}))`({
                policyStatements: [statement],
              });

              return { bucket, oac, distribution };
            }),
          );

          const current = yield* cloudfront.getDistribution({
            Id: deployed.distribution.distributionId,
          });
          expect(current.Distribution?.Status).toEqual("Deployed");
          expect(current.Distribution?.DomainName).toEqual(deployed.distribution.domainName);
          // Duration.Input props reached the wire as whole seconds.
          const config = current.Distribution?.DistributionConfig;
          expect(config?.Origins?.Items?.[0]?.ConnectionTimeout).toEqual(5);
          expect(config?.DefaultCacheBehavior?.MinTTL).toEqual(0);
          expect(config?.DefaultCacheBehavior?.DefaultTTL).toEqual(300);
          expect(config?.DefaultCacheBehavior?.MaxTTL).toEqual(3600);

          const control = yield* cloudfront.getOriginAccessControl({
            Id: deployed.oac.originAccessControlId,
          });
          expect(control.OriginAccessControl?.Id).toEqual(deployed.oac.originAccessControlId);

          yield* S3.putObject({
            Bucket: deployed.bucket.bucketName,
            Key: "index.html",
            Body: "<html>ok</html>",
            ContentType: "text/html; charset=utf-8",
          });

          yield* stack.destroy();
          yield* assertDistributionDeleted(deployed.distribution.distributionId);
        }),
      { tags: ["provider:aws:iam", "provider:aws:s3"], timeout: DEPLOY_DELETE_TIMEOUT },
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
              const bucket = yield* Bucket("ListWebsiteBucket", { forceDestroy: true });
              const oac = yield* OriginAccessControl("ListWebsiteOac", { originType: "s3" });
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

          expect(all.some((d) => d.distributionId === deployed.distributionId)).toBe(true);

          yield* stack.destroy();
          yield* assertDistributionDeleted(deployed.distributionId);
        }),
      { tags: ["provider:aws:s3"], timeout: DEPLOY_DELETE_TIMEOUT },
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
              const oac = yield* OriginAccessControl("GeoOac", { originType: "s3" });
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
                geoRestriction: { restrictionType: "whitelist", locations: ["US", "CA"] },
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
          expect(created.DistributionConfig?.Restrictions?.GeoRestriction.RestrictionType).toEqual(
            "whitelist",
          );
          expect(created.DistributionConfig?.Restrictions?.GeoRestriction.Items?.sort()).toEqual([
            "CA",
            "US",
          ]);
          expect(created.DistributionConfig?.CustomErrorResponses?.Items?.[0].ErrorCode).toEqual(
            404,
          );

          // Update: drop the geo restriction.
          yield* stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* Bucket("GeoBucket", { forceDestroy: true });
              const oac = yield* OriginAccessControl("GeoOac", { originType: "s3" });
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
          expect(updated.DistributionConfig?.Restrictions?.GeoRestriction.RestrictionType).toEqual(
            "none",
          );

          yield* stack.destroy();
          yield* assertDistributionDeleted(deployed.distribution.distributionId);
        }),
      { tags: ["provider:aws:s3"], timeout: DEPLOY_DELETE_TIMEOUT },
    );

    // Regression for the UpdateDistribution full-config-replacement failure:
    // members the props don't express (DefaultRootObject, per-origin
    // CustomHeaders) are set on the live distribution out-of-band, then an
    // alchemy update is deployed. Before `mergeWithObservedConfig`, the update
    // request omitted those members and CloudFront rejected it with
    // `IllegalUpdate` ("Default root object is missing for the resource",
    // "The 'OriginCustomHeaders' field is missing"). Now they are carried over
    // from the observed config while the declared props still win.
    test.provider.skipIf(!runLive)(
      "update preserves config members set out-of-band",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // A plain custom origin keeps the fixture to a single resource — the
          // regression under test lives entirely in the distribution's config
          // update, so no bucket/OAC is needed.
          const program = (defaultTtl: Duration.Input) =>
            Effect.gen(function* () {
              return yield* Distribution("MergeDistribution", {
                origins: [{ id: "site", domainName: "example.com" }],
                defaultCacheBehavior: {
                  targetOriginId: "site",
                  viewerProtocolPolicy: "redirect-to-https",
                  compress: true,
                  forwardedValues: { QueryString: false, Cookies: { Forward: "none" } },
                  minTtl: 0,
                  defaultTtl,
                  maxTtl: "1 hour",
                },
              });
            });

          const deployed = yield* stack.deploy(program("5 minutes"));

          // Out-of-band read-modify-write: enrich the live config with members
          // the props above don't express.
          const live = yield* cloudfront.getDistributionConfig({ Id: deployed.distributionId });
          const liveConfig = live.DistributionConfig!;
          yield* cloudfront.updateDistribution({
            Id: deployed.distributionId,
            IfMatch: live.ETag,
            DistributionConfig: {
              ...liveConfig,
              DefaultRootObject: "index.html",
              Origins: {
                ...liveConfig.Origins,
                Items: liveConfig.Origins.Items.map((origin) => ({
                  ...origin,
                  CustomHeaders: {
                    Quantity: 1,
                    Items: [{ HeaderName: "x-out-of-band", HeaderValue: "kept" }],
                  },
                })),
              },
            },
          });

          // Update via alchemy with a changed prop. The props still don't
          // express the members set above — pre-fix this deploy failed with
          // `IllegalUpdate`.
          yield* stack.deploy(program("10 minutes"));

          const updated = yield* cloudfront.getDistributionConfig({ Id: deployed.distributionId });
          const config = updated.DistributionConfig;
          // Desired wins: the prop change went through.
          expect(config?.DefaultCacheBehavior?.DefaultTTL).toEqual(600);
          // Members the props don't express carried over from the observed
          // config instead of being dropped (or rejected) by the update.
          expect(config?.DefaultRootObject).toEqual("index.html");
          const headers = config?.Origins?.Items?.[0]?.CustomHeaders?.Items?.map((header) => ({
            name: header.HeaderName,
            value:
              typeof header.HeaderValue === "string"
                ? header.HeaderValue
                : Redacted.value(header.HeaderValue),
          }));
          expect(headers).toEqual([{ name: "x-out-of-band", value: "kept" }]);

          yield* stack.destroy();
          yield* assertDistributionDeleted(deployed.distributionId);
        }),
      { timeout: DEPLOY_DELETE_TIMEOUT },
    );

    test.provider(
      "webFunction origin refuses the AllViewer origin request policy",
      (stack) =>
        Effect.gen(function* () {
          const failure = yield* stack
            .plan(
              Effect.gen(function* () {
                const api = yield* AWS.Lambda.WebFunction("HostForwarded", {
                  main: webFunctionMain,
                  authType: "IamAuth",
                });
                return yield* Distribution("HostForwardedCdn", {
                  origins: [{ id: "api", webFunction: api }],
                  defaultCacheBehavior: {
                    targetOriginId: "api",
                    // Managed AllViewer: forwards the viewer's Host header.
                    originRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
                  },
                });
              }),
            )
            .pipe(Effect.exit);
          expect(failure._tag).toBe("Failure");
          expect(String(failure)).toContain("WebFunctionOriginForwardsHost");
        }),
      { tags: ["provider:aws:lambda"], timeout: 60_000 },
    );

    test.provider.skipIf(!runWebFunctions)(
      "webFunction origin: CloudFront signs requests to an IamAuth Web Function",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { api, distribution } = yield* stack.deploy(
            Effect.gen(function* () {
              const api = yield* AWS.Lambda.WebFunction("CdnOrigin", {
                main: webFunctionMain,
                authType: "IamAuth",
              });
              // No cache or origin request policy: a webFunction origin
              // defaults to passing the whole request through uncached.
              const distribution = yield* Distribution("WebFunctionCdn", {
                origins: [{ id: "api", webFunction: api }],
                defaultCacheBehavior: { targetOriginId: "api" },
              });
              return { api, distribution };
            }),
          );

          // Through CloudFront: signed by the origin access control, with the
          // method, query string, body and the viewer's own Authorization
          // header all reaching the server.
          const viaCdn = yield* HttpClient.execute(
            HttpClientRequest.post(`https://${distribution.domainName}/echo?page=2`).pipe(
              HttpClientRequest.setHeader("authorization", "Bearer app-token"),
              HttpClientRequest.bodyText("ping", "text/plain"),
            ),
          ).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json
                : Effect.fail(new Error(`CloudFront returned ${response.status}`)),
            ),
            Effect.retry({
              schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(36)]),
            }),
          );
          expect(viaCdn).toEqual({
            message: "hello through cloudfront",
            method: "POST",
            query: "?page=2",
            body: "ping",
            endpoint: "default",
            authorization: "Bearer app-token",
          });

          // The behavior got the API defaults.
          const config = yield* cloudfront.getDistributionConfig({
            Id: distribution.distributionId,
          });
          const behavior = config.DistributionConfig!.DefaultCacheBehavior;
          expect(behavior.CachePolicyId).toBe(MANAGED_CACHING_DISABLED_POLICY_ID);
          expect(behavior.OriginRequestPolicyId).toBe(
            MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
          );
          expect(behavior.AllowedMethods?.Items.sort()).toEqual([
            "DELETE",
            "GET",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "POST",
            "PUT",
          ]);

          // Directly, unsigned: refused.
          const direct = yield* HttpClient.get(api.url).pipe(Effect.map((r) => r.status));
          expect(direct).toBe(403);

          // Out-of-band: the grant names CloudFront and only this distribution.
          const policy = yield* LambdaWeb.getResourcePolicy({ resourceArn: api.functionArn });
          const statements = (
            JSON.parse(policy.policy) as {
              Statement: Array<{
                Principal: { Service?: string };
                Resource: string;
                Condition?: { StringEquals?: Record<string, string> };
              }>;
            }
          ).Statement;
          expect(statements).toHaveLength(1);
          expect(statements[0]!.Principal.Service).toBe("cloudfront.amazonaws.com");
          expect(statements[0]!.Resource).toBe(api.endpointArn);
          expect(statements[0]!.Condition?.StringEquals?.["aws:SourceArn"]).toBe(
            distribution.distributionArn,
          );

          yield* stack.destroy();
          yield* assertDistributionDeleted(distribution.distributionId);
        }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
      { tags: ["provider:aws:lambda"], timeout: DEPLOY_DELETE_TIMEOUT },
    );

    test.provider.skipIf(!runWebFunctions)(
      "webFunction origin: a multi-Region Web Function is signed with SigV4A",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { api, distribution } = yield* stack.deploy(
            Effect.gen(function* () {
              const api = yield* AWS.Lambda.WebFunction("GlobalCdnOrigin", {
                main: webFunctionMain,
                authType: "IamAuth",
                regions: ["us-east-1"],
              });
              const distribution = yield* Distribution("GlobalWebFunctionCdn", {
                origins: [{ id: "api", webFunction: api }],
                defaultCacheBehavior: { targetOriginId: "api" },
              });
              return { api, distribution };
            }),
          );
          expect(api.endpointType).toBe("MultiRegion");
          expect(api.domainName).toContain(".lambda-web.global.on.aws");

          // The global domain only accepts SigV4A: with SigV4 every request
          // through CloudFront is refused.
          const viaCdn = yield* HttpClient.get(`https://${distribution.domainName}/`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json
                : Effect.fail(new Error(`CloudFront returned ${response.status}`)),
            ),
            Effect.retry({
              schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(36)]),
            }),
          );
          expect(viaCdn).toMatchObject({ message: "hello through cloudfront", method: "GET" });

          // Out-of-band: the origin's access control signs with SigV4A.
          const config = yield* cloudfront.getDistributionConfig({
            Id: distribution.distributionId,
          });
          const originAccessControlId =
            config.DistributionConfig!.Origins.Items[0]!.OriginAccessControlId!;
          const control = yield* cloudfront.getOriginAccessControl({ Id: originAccessControlId });
          expect(control.OriginAccessControl?.OriginAccessControlConfig?.SigningProtocol).toBe(
            "sigv4a",
          );

          yield* stack.destroy();
          yield* assertDistributionDeleted(distribution.distributionId);
        }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
      { tags: ["provider:aws:lambda"], timeout: DEPLOY_DELETE_TIMEOUT },
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
