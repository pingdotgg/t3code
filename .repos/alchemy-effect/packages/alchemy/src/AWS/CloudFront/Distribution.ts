import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";

const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2" as const;

class DistributionFunctionAssociationPending extends Data.TaggedError(
  "DistributionFunctionAssociationPending",
)<{
  message: string;
}> {}

class DistributionPendingDeployment extends Data.TaggedError(
  "DistributionPendingDeployment",
)<{
  message: string;
}> {}

export interface DistributionOrigin {
  /**
   * Unique origin identifier inside the distribution.
   */
  id: string;
  /**
   * Origin domain name.
   */
  domainName: Input<string>;
  /**
   * Optional origin path prefix.
   */
  originPath?: Input<string>;
  /**
   * CloudFront Origin Access Control identifier.
   */
  originAccessControlId?: Input<string>;
  /**
   * Whether the origin should be modeled as an S3 origin.
   * @default false
   */
  s3Origin?: boolean;
  /**
   * Explicit S3 origin settings (legacy Origin Access Identity, read timeout).
   * When set, the origin is treated as an S3 origin regardless of `s3Origin`.
   */
  s3OriginConfig?: {
    originAccessIdentity?: string;
    originReadTimeout?: Duration.Input;
  };
  /**
   * Optional custom origin settings.
   */
  customOriginConfig?: {
    httpPort?: number;
    httpsPort?: number;
    originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
    originReadTimeout?: Duration.Input;
    originKeepaliveTimeout?: Duration.Input;
    originSslProtocols?: cloudfront.SslProtocol[];
    /**
     * IP address type CloudFront uses to connect to the origin.
     */
    ipAddressType?: cloudfront.IpAddressType;
    /**
     * Mutual TLS configuration for the origin connection.
     */
    originMtlsConfig?: {
      clientCertificateArn: string;
    };
  };
  /**
   * Route this origin through a VPC origin (private ALB/NLB/EC2). Mutually
   * exclusive with `s3Origin`/`s3OriginConfig`/`customOriginConfig`.
   */
  vpcOriginConfig?: {
    vpcOriginId: Input<string>;
    originReadTimeout?: Duration.Input;
    originKeepaliveTimeout?: Duration.Input;
    ownerAccountId?: string;
  };
  /**
   * Custom headers CloudFront adds to every request it sends to the origin.
   */
  customHeaders?: Record<string, string>;
  /**
   * Origin Shield configuration.
   */
  originShield?: {
    enabled: boolean;
    originShieldRegion?: string;
  };
  /**
   * Number of times CloudFront attempts to connect to the origin (1-3).
   */
  connectionAttempts?: number;
  /**
   * How long CloudFront waits when trying to establish a connection (1-10
   * seconds), e.g. `"5 seconds"` (a bare number is milliseconds).
   */
  connectionTimeout?: Duration.Input;
  /**
   * How long CloudFront waits for the origin to deliver a complete response,
   * e.g. `"30 seconds"` (a bare number is milliseconds).
   */
  responseCompletionTimeout?: Duration.Input;
}

export interface DistributionBehavior {
  /**
   * ID of the origin (or origin group) this behavior routes requests to.
   */
  targetOriginId: string;
  /**
   * How viewers may connect (e.g. `redirect-to-https`, `https-only`).
   */
  viewerProtocolPolicy?: cloudfront.ViewerProtocolPolicy;
  /**
   * HTTP methods CloudFront accepts and forwards to the origin.
   */
  allowedMethods?: cloudfront.Method[];
  /**
   * HTTP methods whose responses CloudFront caches.
   */
  cachedMethods?: cloudfront.Method[];
  /**
   * Whether CloudFront automatically compresses eligible responses.
   */
  compress?: boolean;
  /**
   * Cache policy ID (a managed policy or a `CachePolicy`) controlling the
   * cache key and TTLs.
   */
  cachePolicyId?: string;
  /**
   * Origin request policy ID controlling which viewer values CloudFront
   * forwards to the origin.
   */
  originRequestPolicyId?: string;
  /**
   * Response headers policy ID applied to viewer responses.
   */
  responseHeadersPolicyId?: string;
  /**
   * Legacy forwarded-values settings. Prefer `cachePolicyId` /
   * `originRequestPolicyId` for new configurations.
   */
  forwardedValues?: cloudfront.ForwardedValues;
  /**
   * Minimum time responses stay cached, e.g. `"1 hour"` (a bare number is
   * milliseconds). Used with `forwardedValues`.
   */
  minTtl?: Duration.Input;
  /**
   * Default time responses stay cached when the origin sends no caching
   * headers.
   */
  defaultTtl?: Duration.Input;
  /**
   * Maximum time responses stay cached.
   */
  maxTtl?: Duration.Input;
  /**
   * CloudFront Functions to run on viewer request/response events.
   */
  functionAssociations?: {
    functionArn: string;
    eventType: cloudfront.EventType;
  }[];
  /**
   * Lambda@Edge functions to run on viewer/origin request/response events.
   */
  lambdaFunctionAssociations?: {
    lambdaFunctionArn: string;
    eventType: cloudfront.EventType;
    includeBody?: boolean;
  }[];
  /**
   * CloudFront KeyGroup IDs whose public keys gate signed URLs/cookies.
   */
  trustedKeyGroups?: Input<string[]>;
  /**
   * Legacy trusted signer AWS account numbers for signed URLs/cookies.
   */
  trustedSigners?: string[];
  /**
   * Field-level encryption configuration ID.
   */
  fieldLevelEncryptionId?: string;
  /**
   * ARN of a real-time log configuration to attach.
   */
  realtimeLogConfigArn?: string;
  /**
   * Whether Microsoft Smooth Streaming is enabled for this behavior.
   */
  smoothStreaming?: boolean;
  /**
   * gRPC configuration for this behavior.
   */
  grpcConfig?: {
    enabled: boolean;
  };
}

export interface DistributionViewerCertificate {
  /**
   * Serve HTTPS with the default `*.cloudfront.net` certificate (no custom
   * domains).
   */
  cloudFrontDefaultCertificate?: boolean;
  /**
   * ARN of an ACM certificate (must live in `us-east-1`) covering the
   * distribution's aliases.
   */
  acmCertificateArn?: string;
  /**
   * How CloudFront serves HTTPS to viewers (`sni-only` for modern clients).
   */
  sslSupportMethod?: cloudfront.SSLSupportMethod;
  /**
   * Minimum TLS protocol version viewers must support.
   */
  minimumProtocolVersion?: cloudfront.MinimumProtocolVersion;
  /**
   * Legacy IAM certificate ID.
   */
  iamCertificateId?: string;
  /**
   * Legacy certificate identifier (IAM/ACM raw value).
   */
  certificate?: string;
  /**
   * Source of the legacy certificate.
   */
  certificateSource?: cloudfront.CertificateSource;
}

export interface DistributionGeoRestriction {
  /**
   * Restriction mode. `none` disables geo restriction.
   */
  restrictionType: cloudfront.GeoRestrictionType;
  /**
   * Two-letter ISO 3166-1 country codes the restriction applies to.
   */
  locations?: string[];
}

export interface DistributionLogging {
  /**
   * Whether access logging is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether cookies are included in access logs.
   */
  includeCookies?: boolean;
  /**
   * S3 bucket (domain name) that receives access logs.
   */
  bucket?: string;
  /**
   * Prefix applied to access log object keys.
   */
  prefix?: string;
}

export interface DistributionOriginGroup {
  /**
   * Origin group identifier (target it from a cache behavior).
   */
  id: string;
  /**
   * Member origin IDs in failover order (primary first, secondary second).
   */
  members: string[];
  /**
   * HTTP status codes that trigger failover to the next member.
   */
  failoverStatusCodes: number[];
  /**
   * How CloudFront selects the origin within the group.
   */
  selectionCriteria?: cloudfront.OriginGroupSelectionCriteria;
}

const isFunctionAssociationPending = (error: cloudfront.InvalidArgument) => {
  const message = error.Message ?? "";
  return (
    message.includes("FunctionAssociationArn") &&
    message.includes("not found or is not published")
  );
};

export interface DistributionProps {
  /**
   * Alternate domain names routed to this distribution.
   */
  aliases?: string[];
  /**
   * Default root object served for `/`.
   */
  defaultRootObject?: string;
  /**
   * CloudFront origin definitions.
   */
  origins: Input<DistributionOrigin[]>;
  /**
   * Default cache behavior.
   */
  defaultCacheBehavior: Input<DistributionBehavior>;
  /**
   * Ordered cache behaviors.
   */
  orderedCacheBehaviors?: Input<
    Array<
      DistributionBehavior & {
        pathPattern: string;
      }
    >
  >;
  /**
   * Custom error response rules.
   */
  customErrorResponses?: Input<cloudfront.CustomErrorResponse[]>;
  /**
   * Human-readable distribution comment.
   * @default ""
   */
  comment?: string;
  /**
   * Whether the distribution should serve traffic.
   * @default true
   */
  enabled?: boolean;
  /**
   * Viewer certificate configuration.
   */
  viewerCertificate?: Input<DistributionViewerCertificate>;
  /**
   * CloudFront price class.
   */
  priceClass?: cloudfront.PriceClass;
  /**
   * Optional AWS WAF web ACL association.
   */
  webAclId?: string;
  /**
   * Preferred HTTP version support.
   */
  httpVersion?: cloudfront.HttpVersion;
  /**
   * Whether IPv6 should be enabled.
   * @default true
   */
  isIpv6Enabled?: boolean;
  /**
   * Geographic distribution restrictions. Defaults to no restriction.
   */
  geoRestriction?: DistributionGeoRestriction;
  /**
   * Standard access logging configuration.
   */
  logging?: DistributionLogging;
  /**
   * Origin failover groups. Target a group id from a cache behavior's
   * `targetOriginId`.
   */
  originGroups?: Input<DistributionOriginGroup[]>;
  /**
   * Continuous deployment policy ID for blue/green deployments.
   */
  continuousDeploymentPolicyId?: string;
  /**
   * Whether this is a staging distribution for blue/green deployments.
   * Create-only — changing it forces a replacement.
   */
  staging?: boolean;
  /**
   * Anycast static IP list ID to associate with the distribution.
   */
  anycastIpListId?: string;
  /**
   * User-defined tags to apply to the distribution.
   */
  tags?: Record<string, string>;
}

export interface Distribution extends Resource<
  "AWS.CloudFront.Distribution",
  DistributionProps,
  {
    /**
     * CloudFront distribution identifier.
     */
    distributionId: string;
    /**
     * ARN of the distribution.
     */
    distributionArn: string;
    /**
     * CloudFront-assigned domain name.
     */
    domainName: string;
    /**
     * Route 53 hosted zone ID for CloudFront aliases.
     */
    hostedZoneId: string;
    /**
     * Current deployment status.
     */
    status: string;
    /**
     * Configured alternate domain names.
     */
    aliases: string[];
    /**
     * Current comment.
     */
    comment: string;
    /**
     * Whether the distribution is enabled.
     */
    enabled: boolean;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Number of invalidation batches still in progress.
     */
    inProgressInvalidationBatches: number;
    /**
     * Last CloudFront modification timestamp.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Current tags on the distribution.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudFront distribution.
 *
 * `Distribution` manages the CDN layer for static sites and HTTP origins such
 * as Lambda Function URLs and ALBs. It exposes the distribution domain and
 * hosted zone ID needed for Route 53 alias records.
 * @resource
 * @section Creating Distributions
 * @example CDN in Front of an HTTP Origin
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const distribution = yield* AWS.CloudFront.Distribution("ApiCdn", {
 *   origins: [
 *     {
 *       id: "api",
 *       domainName: "abc123.lambda-url.us-west-2.on.aws",
 *       customOriginConfig: { originProtocolPolicy: "https-only" },
 *     },
 *   ],
 *   defaultCacheBehavior: {
 *     targetOriginId: "api",
 *     viewerProtocolPolicy: "redirect-to-https",
 *     cachePolicyId: AWS.CloudFront.MANAGED_CACHING_DISABLED_POLICY_ID,
 *     originRequestPolicyId:
 *       AWS.CloudFront.MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
 *   },
 * });
 * ```
 *
 * @example Private S3 Origin
 * ```typescript
 * const distribution = yield* Distribution("WebsiteCdn", {
 *   aliases: ["www.example.com"],
 *   origins: [
 *     {
 *       id: "site",
 *       domainName: bucket.bucketRegionalDomainName,
 *       s3Origin: true,
 *       originAccessControlId: oac.originAccessControlId,
 *     },
 *   ],
 *   defaultCacheBehavior: {
 *     targetOriginId: "site",
 *     viewerProtocolPolicy: "redirect-to-https",
 *     compress: true,
 *   },
 *   viewerCertificate: {
 *     acmCertificateArn: certificate.certificateArn,
 *     sslSupportMethod: "sni-only",
 *     minimumProtocolVersion: "TLSv1.2_2021",
 *   },
 * });
 * ```
 *
 * @section Invalidating the Cache
 * @example Purge Paths on Deploy
 * ```typescript
 * // declaratively, whenever `version` changes:
 * yield* AWS.CloudFront.Invalidation("PurgeBlog", {
 *   distributionId: distribution.distributionId,
 *   paths: ["/blog/*"],
 *   version: buildId,
 * });
 * ```
 *
 * To purge at runtime from a Lambda Function, bind
 * `CloudFront.CreateInvalidation(distribution)` instead.
 */
export const Distribution = Resource<Distribution>(
  "AWS.CloudFront.Distribution",
);

export const DistributionProvider = () =>
  Provider.effect(
    Distribution,
    Effect.gen(function* () {
      const waitForDeployment = Effect.fn(function* (distributionId: string) {
        yield* Effect.logInfo(
          `CloudFront Distribution wait: polling deployment for ${distributionId}`,
        );
        return yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
          Effect.map((response) => response.Distribution),
          Effect.flatMap((distribution) =>
            distribution?.Status === "Deployed"
              ? Effect.gen(function* () {
                  yield* Effect.logInfo(
                    `CloudFront Distribution wait: ${distributionId} deployed`,
                  );
                  return distribution;
                })
              : Effect.gen(function* () {
                  yield* Effect.logInfo(
                    `CloudFront Distribution wait: ${distributionId} status=${distribution?.Status ?? "unknown"}`,
                  );
                  return yield* Effect.fail(
                    new DistributionPendingDeployment({
                      message: `Distribution ${distributionId} is not yet deployed`,
                    }),
                  );
                }),
          ),
          Effect.retry({
            while: (error) => error._tag === "DistributionPendingDeployment",
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      const getCurrent = Effect.fn(function* (distributionId: string) {
        yield* Effect.logInfo(
          `CloudFront Distribution read: loading distribution ${distributionId}`,
        );
        const distribution = yield* cloudfront
          .getDistribution({ Id: distributionId })
          .pipe(
            Effect.map((response) => response.Distribution),
            Effect.catchTag("NoSuchDistribution", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!distribution?.Id) {
          yield* Effect.logInfo(
            `CloudFront Distribution read: distribution ${distributionId} not found`,
          );
          return undefined;
        }

        yield* Effect.logInfo(
          `CloudFront Distribution read: loading config and tags for ${distributionId}`,
        );
        const config = yield* cloudfront.getDistributionConfig({
          Id: distributionId,
        });
        const tags = yield* cloudfront
          .listTagsForResource({
            Resource: distribution.ARN,
          })
          .pipe(Effect.map((response) => toTagsRecord(response.Tags.Items)));

        yield* Effect.logInfo(
          `CloudFront Distribution read: loaded ${distributionId} status=${distribution.Status} enabled=${config.DistributionConfig?.Enabled ?? "unknown"} etag=${config.ETag ?? "missing"} tags=${Object.keys(tags).length}`,
        );
        return {
          distribution,
          config: config.DistributionConfig!,
          etag: config.ETag,
          tags,
        };
      });

      const getByCallerReference = Effect.fn(function* (
        callerReference: string,
      ) {
        yield* Effect.logInfo(
          `CloudFront Distribution read: searching for callerReference=${callerReference}`,
        );
        let marker: string | undefined;

        do {
          const listed = yield* cloudfront.listDistributions({
            Marker: marker,
          });

          for (const item of listed.DistributionList?.Items ?? []) {
            if (!item.Id) continue;

            const config = yield* cloudfront
              .getDistributionConfig({
                Id: item.Id,
              })
              .pipe(
                Effect.catchTag("NoSuchDistribution", () =>
                  Effect.succeed(undefined),
                ),
              );

            if (
              config?.DistributionConfig?.CallerReference === callerReference
            ) {
              yield* Effect.logInfo(
                `CloudFront Distribution read: recovered ${item.Id} for callerReference=${callerReference}`,
              );
              return yield* getCurrent(item.Id);
            }
          }

          marker = listed.DistributionList?.IsTruncated
            ? listed.DistributionList.NextMarker
            : undefined;
        } while (marker);

        yield* Effect.logInfo(
          `CloudFront Distribution read: no distribution found for callerReference=${callerReference}`,
        );
        return undefined;
      });

      const waitForDeletionReady = Effect.fn(function* (
        distributionId: string,
      ) {
        class DistributionPendingDeletionReadiness extends Data.TaggedError(
          "DistributionPendingDeletionReadiness",
        )<{
          message: string;
        }> {}

        yield* Effect.logInfo(
          `CloudFront Distribution delete: waiting for ${distributionId} to become disabled and deployed`,
        );
        return yield* Effect.logInfo(
          `CloudFront Distribution delete: waiting for ${distributionId} to become disabled and deployed`,
        ).pipe(
          Effect.andThen(() => getCurrent(distributionId)),
          Effect.flatMap(
            Effect.fn(function* (current) {
              if (!current) {
                yield* Effect.logInfo(
                  `CloudFront Distribution delete: ${distributionId} already absent while waiting`,
                );
                return undefined;
              }

              if (
                current.config.Enabled ||
                current.distribution.Status !== "Deployed"
              ) {
                yield* Effect.logInfo(
                  `CloudFront Distribution delete: ${distributionId} not ready enabled=${current.config.Enabled} status=${current.distribution.Status}`,
                );
                return yield* Effect.fail(
                  new DistributionPendingDeletionReadiness({
                    message: `Distribution ${distributionId} is not yet ready for deletion`,
                  }),
                );
              }

              yield* Effect.logInfo(
                `CloudFront Distribution delete: ${distributionId} ready for delete with etag=${current.etag ?? "missing"}`,
              );
              return current;
            }),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "DistributionPendingDeletionReadiness",
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      return {
        stables: [
          "distributionId",
          "distributionArn",
          "domainName",
          "hostedZoneId",
        ],
        // `Staging` is create-only at the CloudFront API level; toggling it
        // requires a fresh distribution. Everything else updates in place via
        // the whole-config `updateDistribution` PUT.
        diff: Effect.fn(function* ({ olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as DistributionProps;
          if ((olds?.staging ?? false) !== (news.staging ?? false)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.distributionId) {
            return undefined;
          }

          const current = yield* getCurrent(output.distributionId);
          if (!current) {
            return undefined;
          }

          return toAttrs(current.distribution, current.etag, current.tags);
        }),
        // CloudFront is a global service (no region). Enumerate every
        // distribution in the account via the paginated `listDistributions`
        // op, then resolve each summary to the full `read`-shaped Attributes
        // (distribution + config + tags) so callers get a `delete`-ready item.
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* cloudfront.listDistributions
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.DistributionList?.Items ?? [],
                  ),
                ),
              );

            const rows = yield* Effect.forEach(
              summaries,
              (summary) =>
                getCurrent(summary.Id).pipe(
                  // Hydrating every distribution fires three read calls each
                  // (getDistribution + getDistributionConfig +
                  // listTagsForResource). Across a busy account that trips
                  // CloudFront's low read throttle, so ride it out.
                  Effect.retry({
                    while: (error) => error._tag === "ThrottlingException",
                    // Steady, capped backoff: CloudFront's read throttle
                    // resets quickly, so a fixed cadence drains far faster
                    // than an exponential whose tail delay can balloon past
                    // the test budget on a busy account.
                    schedule: Schedule.max([
                      Schedule.spaced("1 second").pipe(Schedule.jittered),
                      Schedule.recurs(30),
                    ]),
                  }),
                  Effect.map((current) =>
                    current
                      ? toAttrs(
                          current.distribution,
                          current.etag,
                          current.tags,
                        )
                      : undefined,
                  ),
                ),
              { concurrency: 10 },
            );

            return rows.filter(
              (row): row is Distribution["Attributes"] => row !== undefined,
            );
          }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const callerReference = instanceId;

          // Observe — locate an existing distribution by id (cached on
          // `output`) or by caller reference, which lets us recover from a
          // create that succeeded in the cloud but failed to persist its
          // attributes locally.
          let observed = output?.distributionId
            ? yield* getCurrent(output.distributionId)
            : undefined;
          if (!observed) {
            observed = yield* getByCallerReference(callerReference);
          }

          // Ensure — create the distribution if it's missing. Tolerate
          // `DistributionAlreadyExists` (race with a peer reconciler) by
          // re-reading via caller reference. Tags are applied at create
          // time when permissions allow; otherwise we fall back to
          // create-then-tag and the sync path below converges them.
          if (!observed) {
            const config = toConfig(callerReference, news);
            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: callerReference=${callerReference} aliases=${news.aliases?.length ?? 0} origins=${(news.origins as DistributionOrigin[]).length} tags=${Object.keys(desiredTags).length}`,
            );
            const created = yield* cloudfront
              .createDistributionWithTags({
                DistributionConfigWithTags: {
                  DistributionConfig: config,
                  Tags: {
                    Items: createTagsList(desiredTags),
                  },
                },
              })
              .pipe(
                Effect.catch((error) =>
                  isAccessDenied(error)
                    ? Effect.gen(function* () {
                        yield* Effect.logInfo(
                          `CloudFront Distribution reconcile: createDistributionWithTags denied, retrying without tags for callerReference=${callerReference}`,
                        );
                        const created = yield* cloudfront.createDistribution({
                          DistributionConfig: config,
                        });

                        if (
                          created.Distribution?.ARN &&
                          Object.keys(desiredTags).length > 0
                        ) {
                          yield* Effect.logInfo(
                            `CloudFront Distribution reconcile: tagging distribution ${created.Distribution.Id} after fallback`,
                          );
                          yield* cloudfront.tagResource({
                            Resource: created.Distribution.ARN,
                            Tags: {
                              Items: createTagsList(desiredTags),
                            },
                          });
                        }

                        return created;
                      })
                    : Effect.gen(function* () {
                        yield* Effect.logInfo(
                          `CloudFront Distribution reconcile: createDistributionWithTags failed for callerReference=${callerReference} error=${String(error)}`,
                        );
                        return yield* Effect.fail(error);
                      }),
                ),
              )
              .pipe(
                Effect.map((created) => ({
                  distributionId: created.Distribution?.Id,
                  etag: created.ETag,
                  tags: desiredTags,
                })),
                Effect.catchTag("DistributionAlreadyExists", () =>
                  Effect.gen(function* () {
                    yield* Effect.logInfo(
                      `CloudFront Distribution reconcile: callerReference=${callerReference} already exists, attempting recovery`,
                    );
                    const recovered =
                      yield* getByCallerReference(callerReference);
                    if (!recovered?.distribution.Id) {
                      return yield* Effect.fail(
                        new Error(
                          `CloudFront distribution with caller reference '${callerReference}' already exists but could not be recovered`,
                        ),
                      );
                    }
                    return {
                      distributionId: recovered.distribution.Id,
                      etag: recovered.etag,
                      tags: recovered.tags,
                    };
                  }),
                ),
                Effect.catchTag(
                  "InvalidArgument",
                  (
                    error,
                  ): Effect.Effect<
                    never,
                    | cloudfront.InvalidArgument
                    | DistributionFunctionAssociationPending
                  > =>
                    isFunctionAssociationPending(error)
                      ? Effect.logInfo(
                          "CloudFront Distribution reconcile: function association not yet ready, retrying",
                        ).pipe(
                          Effect.andThen(
                            Effect.fail(
                              new DistributionFunctionAssociationPending({
                                message:
                                  error.Message ??
                                  "CloudFront function association pending",
                              }),
                            ),
                          ),
                        )
                      : Effect.fail(error),
                ),
                Effect.retry({
                  while: (error) =>
                    error instanceof DistributionFunctionAssociationPending,
                  schedule: Schedule.max([
                    Schedule.fixed("5 seconds"),
                    Schedule.recurs(24),
                  ]),
                }),
              );

            if (!created.distributionId) {
              return yield* Effect.fail(
                new Error("createDistribution returned no distribution"),
              );
            }

            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: created ${created.distributionId} etag=${created.etag ?? "missing"}, waiting for deployment`,
            );
            const deployed = yield* waitForDeployment(created.distributionId);
            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: deployed ${created.distributionId} domain=${deployed.DomainName}`,
            );
            yield* session.note(created.distributionId);
            return toAttrs(deployed, created.etag, created.tags);
          }

          // Sync config — diff observed config against desired and patch
          // via `updateDistribution` with the freshly observed ETag. We
          // keep the observed `CallerReference` because CloudFront does
          // not allow it to change.
          yield* Effect.logInfo(
            `CloudFront Distribution reconcile: updating config for ${observed.distribution.Id} with etag=${observed.etag ?? "missing"}`,
          );
          const updated = yield* cloudfront
            .updateDistribution({
              Id: observed.distribution.Id,
              IfMatch: observed.etag,
              DistributionConfig: toConfig(
                observed.config.CallerReference,
                news,
              ),
            })
            .pipe(
              Effect.catchTag(
                "InvalidArgument",
                (
                  error,
                ): Effect.Effect<
                  never,
                  | cloudfront.InvalidArgument
                  | DistributionFunctionAssociationPending
                > =>
                  isFunctionAssociationPending(error)
                    ? Effect.logInfo(
                        "CloudFront Distribution reconcile: function association not yet ready, retrying",
                      ).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new DistributionFunctionAssociationPending({
                              message:
                                error.Message ??
                                "CloudFront function association pending",
                            }),
                          ),
                        ),
                      )
                    : Effect.fail(error),
              ),
              Effect.retry({
                while: (error) =>
                  error instanceof DistributionFunctionAssociationPending,
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
            );

          if (!updated.Distribution?.Id) {
            return yield* Effect.fail(
              new Error("updateDistribution returned no distribution"),
            );
          }

          // Sync tags — diff observed cloud tags against desired and apply
          // only the delta. `observed.tags` is fetched fresh, so we don't
          // rely on stale `olds.tags`.
          const { removed, upsert } = diffTags(observed.tags, desiredTags);
          yield* Effect.logInfo(
            `CloudFront Distribution reconcile: distribution=${observed.distribution.Id} upsertTags=${upsert.length} removedTags=${removed.length}`,
          );

          if (upsert.length > 0) {
            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: tagging ${observed.distribution.Id} with ${upsert.length} tag(s)`,
            );
            yield* cloudfront.tagResource({
              Resource: observed.distribution.ARN,
              Tags: {
                Items: upsert,
              },
            });
          }

          if (removed.length > 0) {
            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: removing ${removed.length} tag(s) from ${observed.distribution.Id}`,
            );
            yield* cloudfront.untagResource({
              Resource: observed.distribution.ARN,
              TagKeys: {
                Items: removed,
              },
            });
          }

          yield* Effect.logInfo(
            `CloudFront Distribution reconcile: updated ${observed.distribution.Id} etag=${updated.ETag ?? "missing"}, waiting for deployment`,
          );
          const deployed = yield* waitForDeployment(updated.Distribution.Id);
          yield* Effect.logInfo(
            `CloudFront Distribution reconcile: deployed ${observed.distribution.Id} domain=${deployed.DomainName}`,
          );
          yield* session.note(observed.distribution.Id);
          return toAttrs(deployed, updated.ETag, desiredTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Effect.logInfo(
            `CloudFront Distribution delete: distribution=${output.distributionId}`,
          );
          const current = yield* getCurrent(output.distributionId);
          if (!current) {
            yield* Effect.logInfo(
              `CloudFront Distribution delete: ${output.distributionId} already absent`,
            );
            return;
          }

          if (current.config.Enabled) {
            yield* Effect.logInfo(
              `CloudFront Distribution delete: disabling ${output.distributionId} before delete`,
            );
            yield* cloudfront.updateDistribution({
              Id: output.distributionId,
              IfMatch: current.etag,
              DistributionConfig: {
                ...current.config,
                Enabled: false,
              },
            });
          }

          const latest = yield* waitForDeletionReady(output.distributionId);
          if (!latest) {
            yield* Effect.logInfo(
              `CloudFront Distribution delete: ${output.distributionId} disappeared before delete`,
            );
            return;
          }

          yield* Effect.logInfo(
            `CloudFront Distribution delete: deleting ${output.distributionId} with etag=${latest.etag ?? "missing"}`,
          );
          yield* cloudfront
            .deleteDistribution({
              Id: output.distributionId,
              IfMatch: latest.etag,
            })
            .pipe(Effect.catchTag("NoSuchDistribution", () => Effect.void));
        }),
      };
    }),
  );

const toTagsRecord = (tags: cloudfront.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const isAccessDenied = (error: unknown) => {
  const tag = (error as { _tag?: string; name?: string })?._tag;
  const name = (error as { _tag?: string; name?: string })?.name;
  const text = String(error);
  return (
    tag === "AccessDenied" ||
    tag === "AccessDeniedException" ||
    name === "AccessDenied" ||
    name === "AccessDeniedException" ||
    text.includes("AccessDenied")
  );
};

const toBehavior = (
  behavior: DistributionBehavior & {
    pathPattern?: string;
  },
): cloudfront.CacheBehavior | cloudfront.DefaultCacheBehavior => ({
  ...(behavior.pathPattern ? { PathPattern: behavior.pathPattern } : undefined),
  TargetOriginId: behavior.targetOriginId,
  ViewerProtocolPolicy: behavior.viewerProtocolPolicy ?? "redirect-to-https",
  AllowedMethods: behavior.allowedMethods
    ? {
        Quantity: behavior.allowedMethods.length,
        Items: behavior.allowedMethods,
        CachedMethods: behavior.cachedMethods
          ? {
              Quantity: behavior.cachedMethods.length,
              Items: behavior.cachedMethods,
            }
          : undefined,
      }
    : undefined,
  Compress: behavior.compress ?? true,
  CachePolicyId: behavior.cachePolicyId,
  OriginRequestPolicyId: behavior.originRequestPolicyId,
  ResponseHeadersPolicyId: behavior.responseHeadersPolicyId,
  ForwardedValues: behavior.forwardedValues,
  MinTTL: toWireSeconds(behavior.minTtl),
  DefaultTTL: toWireSeconds(behavior.defaultTtl),
  MaxTTL: toWireSeconds(behavior.maxTtl),
  TrustedKeyGroups: behavior.trustedKeyGroups
    ? {
        Enabled: (behavior.trustedKeyGroups as string[]).length > 0,
        Quantity: (behavior.trustedKeyGroups as string[]).length,
        Items: behavior.trustedKeyGroups as string[],
      }
    : undefined,
  TrustedSigners: behavior.trustedSigners
    ? {
        Enabled: behavior.trustedSigners.length > 0,
        Quantity: behavior.trustedSigners.length,
        Items: behavior.trustedSigners,
      }
    : undefined,
  FieldLevelEncryptionId: behavior.fieldLevelEncryptionId,
  RealtimeLogConfigArn: behavior.realtimeLogConfigArn,
  SmoothStreaming: behavior.smoothStreaming,
  GrpcConfig: behavior.grpcConfig
    ? { Enabled: behavior.grpcConfig.enabled }
    : undefined,
  FunctionAssociations: behavior.functionAssociations
    ? {
        Quantity: behavior.functionAssociations.length,
        Items: behavior.functionAssociations.map((association) => ({
          FunctionARN: association.functionArn,
          EventType: association.eventType,
        })),
      }
    : undefined,
  LambdaFunctionAssociations: behavior.lambdaFunctionAssociations
    ? {
        Quantity: behavior.lambdaFunctionAssociations.length,
        Items: behavior.lambdaFunctionAssociations.map((association) => ({
          LambdaFunctionARN: association.lambdaFunctionArn,
          EventType: association.eventType,
          IncludeBody: association.includeBody,
        })),
      }
    : undefined,
});

const toOrigin = (origin: DistributionOrigin): cloudfront.Origin => {
  // Exactly one of the three origin-config shapes may be set. A VPC origin
  // wins, then an explicit/legacy S3 origin, otherwise a custom origin.
  const isVpcOrigin = origin.vpcOriginConfig !== undefined;
  const isS3Origin =
    !isVpcOrigin &&
    (origin.s3Origin === true || origin.s3OriginConfig !== undefined);

  return {
    Id: origin.id,
    DomainName: origin.domainName as string,
    OriginPath: origin.originPath as string | undefined,
    OriginAccessControlId: origin.originAccessControlId as string | undefined,
    CustomHeaders: origin.customHeaders
      ? {
          Quantity: Object.keys(origin.customHeaders).length,
          Items: Object.entries(origin.customHeaders).map(([name, value]) => ({
            HeaderName: name,
            HeaderValue: value,
          })),
        }
      : undefined,
    OriginShield: origin.originShield
      ? {
          Enabled: origin.originShield.enabled,
          OriginShieldRegion: origin.originShield.originShieldRegion,
        }
      : undefined,
    ConnectionAttempts: origin.connectionAttempts,
    ConnectionTimeout: toWireSeconds(origin.connectionTimeout),
    ResponseCompletionTimeout: toWireSeconds(origin.responseCompletionTimeout),
    VpcOriginConfig: isVpcOrigin
      ? {
          VpcOriginId: origin.vpcOriginConfig!.vpcOriginId as string,
          OwnerAccountId: origin.vpcOriginConfig!.ownerAccountId,
          OriginReadTimeout: toWireSeconds(
            origin.vpcOriginConfig!.originReadTimeout,
          ),
          OriginKeepaliveTimeout: toWireSeconds(
            origin.vpcOriginConfig!.originKeepaliveTimeout,
          ),
        }
      : undefined,
    S3OriginConfig: isS3Origin
      ? {
          OriginAccessIdentity:
            origin.s3OriginConfig?.originAccessIdentity ?? "",
          OriginReadTimeout: toWireSeconds(
            origin.s3OriginConfig?.originReadTimeout,
          ),
        }
      : undefined,
    CustomOriginConfig:
      isVpcOrigin || isS3Origin
        ? undefined
        : {
            HTTPPort: origin.customOriginConfig?.httpPort ?? 80,
            HTTPSPort: origin.customOriginConfig?.httpsPort ?? 443,
            OriginProtocolPolicy:
              origin.customOriginConfig?.originProtocolPolicy ?? "https-only",
            OriginSslProtocols: {
              Quantity: (
                origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"]
              ).length,
              Items: origin.customOriginConfig?.originSslProtocols ?? [
                "TLSv1.2",
              ],
            },
            OriginReadTimeout: toWireSeconds(
              origin.customOriginConfig?.originReadTimeout,
            ),
            OriginKeepaliveTimeout: toWireSeconds(
              origin.customOriginConfig?.originKeepaliveTimeout,
            ),
            IpAddressType: origin.customOriginConfig?.ipAddressType,
            OriginMtlsConfig: origin.customOriginConfig?.originMtlsConfig
              ? {
                  ClientCertificateArn:
                    origin.customOriginConfig.originMtlsConfig
                      .clientCertificateArn,
                }
              : undefined,
          },
  };
};

const toConfig = (
  callerReference: string,
  props: DistributionProps,
): cloudfront.DistributionConfig => ({
  CallerReference: callerReference,
  Aliases: props.aliases
    ? {
        Quantity: props.aliases.length,
        Items: props.aliases,
      }
    : undefined,
  DefaultRootObject: props.defaultRootObject,
  Origins: {
    Quantity: (props.origins as DistributionOrigin[]).length,
    Items: (props.origins as DistributionOrigin[]).map(toOrigin),
  },
  DefaultCacheBehavior: toBehavior(
    props.defaultCacheBehavior as DistributionBehavior,
  ) as cloudfront.DefaultCacheBehavior,
  CacheBehaviors: props.orderedCacheBehaviors
    ? {
        Quantity: (
          props.orderedCacheBehaviors as Array<
            DistributionBehavior & { pathPattern: string }
          >
        ).length,
        Items: (
          props.orderedCacheBehaviors as Array<
            DistributionBehavior & { pathPattern: string }
          >
        ).map((behavior) =>
          toBehavior(
            behavior as DistributionBehavior & { pathPattern: string },
          ),
        ) as cloudfront.CacheBehavior[],
      }
    : undefined,
  OriginGroups: props.originGroups
    ? {
        Quantity: (props.originGroups as DistributionOriginGroup[]).length,
        Items: (props.originGroups as DistributionOriginGroup[]).map(
          (group) => ({
            Id: group.id,
            FailoverCriteria: {
              StatusCodes: {
                Quantity: group.failoverStatusCodes.length,
                Items: group.failoverStatusCodes,
              },
            },
            Members: {
              Quantity: group.members.length,
              Items: group.members.map((originId) => ({ OriginId: originId })),
            },
            SelectionCriteria: group.selectionCriteria,
          }),
        ),
      }
    : undefined,
  CustomErrorResponses: props.customErrorResponses
    ? {
        Quantity: (
          props.customErrorResponses as cloudfront.CustomErrorResponse[]
        ).length,
        Items: props.customErrorResponses as cloudfront.CustomErrorResponse[],
      }
    : undefined,
  Comment: props.comment ?? "",
  Logging: props.logging
    ? {
        Enabled: props.logging.enabled ?? true,
        IncludeCookies: props.logging.includeCookies ?? false,
        Bucket: props.logging.bucket ?? "",
        Prefix: props.logging.prefix ?? "",
      }
    : undefined,
  Enabled: props.enabled ?? true,
  ViewerCertificate: props.viewerCertificate
    ? {
        CloudFrontDefaultCertificate: (
          props.viewerCertificate as DistributionViewerCertificate
        ).cloudFrontDefaultCertificate,
        IAMCertificateId: (
          props.viewerCertificate as DistributionViewerCertificate
        ).iamCertificateId,
        ACMCertificateArn: (
          props.viewerCertificate as DistributionViewerCertificate
        ).acmCertificateArn,
        SSLSupportMethod: (
          props.viewerCertificate as DistributionViewerCertificate
        ).sslSupportMethod,
        MinimumProtocolVersion: (
          props.viewerCertificate as DistributionViewerCertificate
        ).minimumProtocolVersion,
        Certificate: (props.viewerCertificate as DistributionViewerCertificate)
          .certificate,
        CertificateSource: (
          props.viewerCertificate as DistributionViewerCertificate
        ).certificateSource,
      }
    : props.aliases && props.aliases.length > 0
      ? undefined
      : {
          CloudFrontDefaultCertificate: true,
        },
  Restrictions: props.geoRestriction
    ? {
        GeoRestriction: {
          RestrictionType: props.geoRestriction.restrictionType,
          Quantity: props.geoRestriction.locations?.length ?? 0,
          Items: props.geoRestriction.locations,
        },
      }
    : {
        GeoRestriction: {
          RestrictionType: "none",
          Quantity: 0,
        },
      },
  PriceClass: props.priceClass,
  WebACLId: props.webAclId,
  HttpVersion: props.httpVersion ?? "http2",
  IsIPV6Enabled: props.isIpv6Enabled ?? true,
  ContinuousDeploymentPolicyId: props.continuousDeploymentPolicyId,
  Staging: props.staging,
  AnycastIpListId: props.anycastIpListId,
});

const toAttrs = (
  distribution: cloudfront.Distribution,
  etag: string | undefined,
  tags: Record<string, string>,
): Distribution["Attributes"] => ({
  distributionId: distribution.Id,
  distributionArn: distribution.ARN,
  domainName: distribution.DomainName,
  hostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
  status: distribution.Status,
  aliases: distribution.DistributionConfig.Aliases?.Items ?? [],
  comment:
    typeof distribution.DistributionConfig.Comment === "string"
      ? distribution.DistributionConfig.Comment
      : "",
  enabled: distribution.DistributionConfig.Enabled,
  etag,
  inProgressInvalidationBatches: distribution.InProgressInvalidationBatches,
  lastModifiedTime: distribution.LastModifiedTime,
  tags,
});
