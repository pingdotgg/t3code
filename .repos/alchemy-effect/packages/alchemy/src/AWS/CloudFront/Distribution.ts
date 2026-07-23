import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
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
   * Optional custom origin settings.
   */
  customOriginConfig?: {
    httpPort?: number;
    httpsPort?: number;
    originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
    originReadTimeout?: number;
    originKeepaliveTimeout?: number;
    originSslProtocols?: cloudfront.SslProtocol[];
  };
}

export interface DistributionBehavior {
  targetOriginId: string;
  viewerProtocolPolicy?: cloudfront.ViewerProtocolPolicy;
  allowedMethods?: cloudfront.Method[];
  cachedMethods?: cloudfront.Method[];
  compress?: boolean;
  cachePolicyId?: string;
  originRequestPolicyId?: string;
  responseHeadersPolicyId?: string;
  forwardedValues?: cloudfront.ForwardedValues;
  minTtl?: number;
  defaultTtl?: number;
  maxTtl?: number;
  functionAssociations?: {
    functionArn: string;
    eventType: cloudfront.EventType;
  }[];
  lambdaFunctionAssociations?: {
    lambdaFunctionArn: string;
    eventType: cloudfront.EventType;
    includeBody?: boolean;
  }[];
}

export interface DistributionViewerCertificate {
  cloudFrontDefaultCertificate?: boolean;
  acmCertificateArn?: string;
  sslSupportMethod?: cloudfront.SSLSupportMethod;
  minimumProtocolVersion?: cloudfront.MinimumProtocolVersion;
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
 *
 * @section Creating Distributions
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
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
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
            Effect.fnUntraced(function* (current) {
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
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
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
                  schedule: Schedule.fixed("5 seconds").pipe(
                    Schedule.both(Schedule.recurs(24)),
                  ),
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
                schedule: Schedule.fixed("5 seconds").pipe(
                  Schedule.both(Schedule.recurs(24)),
                ),
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
  MinTTL: behavior.minTtl,
  DefaultTTL: behavior.defaultTtl,
  MaxTTL: behavior.maxTtl,
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

const toOrigin = (origin: DistributionOrigin): cloudfront.Origin => ({
  Id: origin.id,
  DomainName: origin.domainName as string,
  OriginPath: origin.originPath as string | undefined,
  OriginAccessControlId: origin.originAccessControlId as string | undefined,
  S3OriginConfig: origin.s3Origin ? { OriginAccessIdentity: "" } : undefined,
  CustomOriginConfig: origin.s3Origin
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
          Items: origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"],
        },
        OriginReadTimeout: origin.customOriginConfig?.originReadTimeout,
        OriginKeepaliveTimeout:
          origin.customOriginConfig?.originKeepaliveTimeout,
      },
});

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
  CustomErrorResponses: props.customErrorResponses
    ? {
        Quantity: (
          props.customErrorResponses as cloudfront.CustomErrorResponse[]
        ).length,
        Items: props.customErrorResponses as cloudfront.CustomErrorResponse[],
      }
    : undefined,
  Comment: props.comment ?? "",
  Enabled: props.enabled ?? true,
  ViewerCertificate: props.viewerCertificate
    ? {
        CloudFrontDefaultCertificate: (
          props.viewerCertificate as DistributionViewerCertificate
        ).cloudFrontDefaultCertificate,
        ACMCertificateArn: (
          props.viewerCertificate as DistributionViewerCertificate
        ).acmCertificateArn,
        SSLSupportMethod: (
          props.viewerCertificate as DistributionViewerCertificate
        ).sslSupportMethod,
        MinimumProtocolVersion: (
          props.viewerCertificate as DistributionViewerCertificate
        ).minimumProtocolVersion,
      }
    : props.aliases && props.aliases.length > 0
      ? undefined
      : {
          CloudFrontDefaultCertificate: true,
        },
  Restrictions: {
    GeoRestriction: {
      RestrictionType: "none",
      Quantity: 0,
    },
  },
  PriceClass: props.priceClass,
  WebACLId: props.webAclId,
  HttpVersion: props.httpVersion ?? "http2",
  IsIPV6Enabled: props.isIpv6Enabled ?? true,
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
