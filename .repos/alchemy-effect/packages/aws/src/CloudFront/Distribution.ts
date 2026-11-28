import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { createInternalTags, createTagsList, diffTags } from "alchemy/Tags";
import { toWireSeconds } from "alchemy/Util/Duration";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import {
  WebFunctionPermission,
  type WebFunctionEndpointRef,
} from "../Lambda/WebFunctionPermission.ts";
import type { Providers } from "../Providers.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
} from "./ManagedPolicies.ts";
import { OriginAccessControl } from "./OriginAccessControl.ts";

export class DistributionConflict extends Data.TaggedError("DistributionConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DistributionUnexpectedResponse extends Data.TaggedError(
  "DistributionUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2" as const;

class DistributionFunctionAssociationPending extends Data.TaggedError(
  "DistributionFunctionAssociationPending",
)<{
  message: string;
}> {}

class DistributionPendingDeployment extends Data.TaggedError("DistributionPendingDeployment")<{
  message: string;
}> {}

/**
 * A Lambda Web Function endpoint to serve as an origin: an
 * `AWS.Lambda.WebFunction` (its built-in endpoint), an
 * `AWS.Lambda.WebFunctionEndpoint`, or a class declaration of either.
 */
export interface WebFunctionOriginTarget extends WebFunctionEndpointRef {
  domainName: string;
  /** A `MultiRegion` endpoint's global domain needs SigV4A signatures. */
  endpointType: string;
}

const signingProtocolFor = (endpointType: string) =>
  endpointType === "MultiRegion" ? "sigv4a" : "sigv4";

export interface DistributionOrigin {
  /**
   * Unique origin identifier inside the distribution.
   */
  id: string;
  /**
   * Origin domain name. Required unless {@link webFunction} is set.
   */
  domainName?: Input<string>;
  /**
   * Serve a Lambda Web Function endpoint through this origin. Alchemy sets
   * the origin's domain, sends HTTPS, creates an origin access control that
   * signs every origin request, and grants this distribution (and only this
   * distribution) permission to invoke the endpoint. The endpoint must use
   * `authType: "IamAuth"`, so requests that bypass CloudFront are refused.
   *
   * Behaviors targeting this origin default to an API setup: no caching,
   * the whole viewer request forwarded except `Host` (Lambda routes on
   * it), and every HTTP method allowed. Set `cachePolicyId`,
   * `originRequestPolicyId` or `allowedMethods` on the behavior to change
   * that.
   */
  webFunction?: WebFunctionOriginTarget | Effect.Effect<WebFunctionOriginTarget, never, Providers>;
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
  const message = error.message ?? "";
  return (
    message.includes("FunctionAssociationArn") && message.includes("not found or is not published")
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

/**
 * Binding contract of {@link Distribution}: composites contribute additional
 * alternate domain names without a circular input prop (e.g. a site attached
 * to an `AWS.Website.Router` binds its hostnames onto the Router's
 * distribution). Bound aliases are merged with the declared `aliases` prop
 * at reconcile time; the viewer certificate must cover them.
 */
export type DistributionBinding = {
  /**
   * Additional alternate domain names (CNAMEs) attached to the
   * distribution.
   */
  aliases?: string[];
};

/**
 * Union of declared and bound aliases (see {@link DistributionBinding}),
 * deduped, preserving declared order first. Tolerates both `{ sid, data }`
 * rows (provider lifecycle) and bare binding payloads.
 * @internal
 */
const resolveEffectiveAliases = (
  declared: string[] | undefined,
  bindings: ReadonlyArray<DistributionBinding | ResourceBinding<DistributionBinding>> | undefined,
): string[] | undefined => {
  const bound = (bindings ?? []).flatMap((binding) =>
    "data" in binding && binding.data !== undefined
      ? ((binding as ResourceBinding<DistributionBinding>).data.aliases ?? [])
      : ((binding as DistributionBinding).aliases ?? []),
  );
  if (bound.length === 0) {
    return declared;
  }
  return [...new Set([...(declared ?? []), ...bound])];
};

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
     * The distribution's own URL — what a viewer opens.
     *
     * `https://{domainName}` on AWS. Under `alchemy dev` the emulator has no
     * such hostname to offer (`*.cloudfront.net` resolves to nothing on a
     * developer's machine), so it serves the distribution's edge on a local
     * port and this is `http://localhost:{port}`. Reading `url` instead of
     * building one from {@link domainName} is what makes a consumer work
     * unchanged in both modes.
     */
    url: string;
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
  DistributionBinding,
  Providers
> {}

const DistributionResource = Resource<Distribution>("AWS.CloudFront.Distribution");

/** CloudFront's managed `AllViewer` origin request policy: forwards `Host`. */
const MANAGED_ALL_VIEWER_ORIGIN_REQUEST_POLICY_ID = "216adef6-5c7f-47e4-b989-5492eafa07d3";

const ALL_METHODS: cloudfront.Method[] = [
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "PATCH",
  "POST",
  "DELETE",
];

/** A behavior targeting a `webFunction` origin forwards the viewer's `Host`. */
export class WebFunctionOriginForwardsHost extends Data.TaggedError(
  "WebFunctionOriginForwardsHost",
)<{ distributionId: string; targetOriginId: string; message: string }> {}

/**
 * Behaviors that target a Lambda Web Function origin serve an API, not
 * static files: unless the behavior says otherwise, don't cache, forward
 * the whole viewer request except `Host` (Lambda routes on it), and allow
 * every method. CloudFront's own defaults (cache GETs for a day, drop query
 * strings, cookies and headers, GET/HEAD only) would break the server.
 */
const apiBehaviorDefaults = <B extends DistributionBehavior>(
  distributionId: string,
  webOriginIds: ReadonlySet<string>,
  behavior: B,
): Effect.Effect<B> => {
  if (!webOriginIds.has(behavior.targetOriginId)) return Effect.succeed(behavior);
  if (behavior.originRequestPolicyId === MANAGED_ALL_VIEWER_ORIGIN_REQUEST_POLICY_ID) {
    return Effect.die(
      new WebFunctionOriginForwardsHost({
        distributionId,
        targetOriginId: behavior.targetOriginId,
        message: `AWS.CloudFront.Distribution "${distributionId}": the behavior for Lambda Web Function origin "${behavior.targetOriginId}" uses the AllViewer origin request policy, which forwards the viewer's Host header. Lambda routes on Host and would answer 404. Omit originRequestPolicyId to use AllViewerExceptHostHeader.`,
      }),
    );
  }
  const legacy = behavior.forwardedValues !== undefined;
  return Effect.succeed({
    ...behavior,
    ...(behavior.allowedMethods === undefined
      ? { allowedMethods: ALL_METHODS, cachedMethods: behavior.cachedMethods ?? ["GET", "HEAD"] }
      : {}),
    ...(behavior.cachePolicyId === undefined && !legacy
      ? { cachePolicyId: MANAGED_CACHING_DISABLED_POLICY_ID }
      : {}),
    ...(behavior.originRequestPolicyId === undefined && !legacy
      ? { originRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID }
      : {}),
  });
};

/**
 * Compose the children a `webFunction` origin needs: an origin access
 * control before the distribution, and an invoke grant scoped to the
 * distribution after it (the grant needs the distribution's ARN, which is
 * why it is its own resource rather than part of the function).
 */
const withWebFunctionOrigins = (
  id: string,
  props: DistributionProps | Effect.Effect<DistributionProps, never, Providers>,
): Effect.Effect<Distribution, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    const origins: unknown = resolved.origins;
    if (
      globalThis.__ALCHEMY_RUNTIME__ ||
      !Array.isArray(origins) ||
      !origins.some((origin: DistributionOrigin) => origin.webFunction !== undefined)
    ) {
      return yield* DistributionResource(id, resolved);
    }
    const targets: { originId: string; target: WebFunctionOriginTarget }[] = [];
    const nextOrigins = yield* Effect.forEach(origins as DistributionOrigin[], (origin) =>
      Effect.gen(function* () {
        if (origin.webFunction === undefined) return origin;
        const target = Effect.isEffect(origin.webFunction)
          ? yield* origin.webFunction
          : origin.webFunction;
        targets.push({ originId: origin.id, target });
        const access = yield* OriginAccessControl(`${origin.id}OriginAccess`, {
          description: `Signs requests from ${id} to Lambda Web Function origin ${origin.id}`,
          originType: "lambda",
          signingBehavior: "always-amz-auth",
          signingProtocol: Output.isOutput(target.endpointType)
            ? Output.map(target.endpointType as Output.Output<string>, signingProtocolFor)
            : signingProtocolFor(target.endpointType),
        });
        const { webFunction: _webFunction, ...rest } = origin;
        return {
          ...rest,
          domainName: target.domainName,
          originAccessControlId: access.originAccessControlId,
          customOriginConfig: {
            originProtocolPolicy: "https-only" as const,
            ...rest.customOriginConfig,
          },
        } satisfies DistributionOrigin;
      }),
    ).pipe(Namespace.push(id));
    const webOriginIds = new Set(targets.map((t) => t.originId));
    const forWebFunction = <B extends DistributionBehavior>(behavior: B) =>
      apiBehaviorDefaults(id, webOriginIds, behavior);
    const defaultCacheBehavior = Output.isOutput(resolved.defaultCacheBehavior)
      ? resolved.defaultCacheBehavior
      : yield* forWebFunction(resolved.defaultCacheBehavior as DistributionBehavior);
    const orderedCacheBehaviors =
      resolved.orderedCacheBehaviors === undefined ||
      Output.isOutput(resolved.orderedCacheBehaviors)
        ? resolved.orderedCacheBehaviors
        : yield* Effect.forEach(
            resolved.orderedCacheBehaviors as (DistributionBehavior & { pathPattern: string })[],
            forWebFunction,
          );
    const distribution = yield* DistributionResource(id, {
      ...resolved,
      origins: nextOrigins,
      defaultCacheBehavior,
      orderedCacheBehaviors,
    });
    yield* Effect.forEach(targets, ({ originId, target }) =>
      WebFunctionPermission(`${originId}Invoke`, {
        endpoint: target,
        principal: "cloudfront.amazonaws.com",
        sourceArn: distribution.distributionArn,
      }),
    ).pipe(Namespace.push(id));
    return distribution;
  });

/**
 * A CloudFront distribution.
 *
 * `Distribution` manages the CDN layer for static sites and HTTP origins such
 * as Lambda Function URLs and ALBs. It exposes the distribution domain and
 * hosted zone ID needed for Route 53 alias records.
 * ### Creating Distributions
 * **Example:** CDN in Front of an HTTP Origin
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
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
 * **Example:** Private S3 Origin
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
 * ### Lambda Web Function Origins
 * Set `webFunction` on an origin to serve an `AWS.Lambda.WebFunction` (or a
 * `WebFunctionEndpoint`) through CloudFront. Alchemy creates the origin
 * access control that signs each origin request and grants only this
 * distribution permission to invoke the endpoint. The endpoint must use
 * `authType: "IamAuth"`, so requests that skip CloudFront are refused.
 *
 * **Example:** CloudFront in front of a Web Function
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 * });
 *
 * const cdn = yield* AWS.CloudFront.Distribution("Cdn", {
 *   origins: [{ id: "api", webFunction: api }],
 *   defaultCacheBehavior: { targetOriginId: "api" },
 * });
 * ```
 *
 * Behaviors that target the origin don't cache, forward the whole viewer
 * request except `Host`, and allow every method. Override any of that on
 * the behavior, e.g. cache static assets under a path:
 *
 * **Example:** Cache one path, pass everything else through
 * ```typescript
 * const cdn = yield* AWS.CloudFront.Distribution("Cdn", {
 *   origins: [{ id: "api", webFunction: api }],
 *   defaultCacheBehavior: { targetOriginId: "api" },
 *   orderedCacheBehaviors: [
 *     {
 *       pathPattern: "/assets/*",
 *       targetOriginId: "api",
 *       cachePolicyId: AWS.CloudFront.MANAGED_CACHING_OPTIMIZED_POLICY_ID,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Invalidating the Cache
 * **Example:** Purge Paths on Deploy
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
 *
 * @resource
 */
export const Distribution: typeof DistributionResource = Object.assign(
  (id: string, props: DistributionProps | Effect.Effect<DistributionProps, never, Providers>) =>
    withWebFunctionOrigins(id, props),
  DistributionResource,
) as unknown as typeof DistributionResource;

export const DistributionProvider = () =>
  Provider.effect(
    Distribution,
    Effect.gen(function* () {
      const waitForDeployment = Effect.fn(function* (distributionId: string) {
        yield* Effect.logInfo(
          `CloudFront Distribution wait: polling deployment for ${distributionId}`,
        );
        return yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
          // Bound each poll — a wedged read must count as "not deployed
          // yet" and retry, never hang the deploy (see the delete-wait).
          Effect.timeoutOrElse({
            duration: 30_000,
            orElse: () =>
              Effect.fail(
                new DistributionPendingDeployment({
                  message: `Timed out reading distribution ${distributionId} while polling deployment`,
                }),
              ),
          }),
          Effect.map((response) => response.Distribution),
          Effect.flatMap((distribution) =>
            distribution?.Status === "Deployed"
              ? Effect.gen(function* () {
                  yield* Effect.logInfo(`CloudFront Distribution wait: ${distributionId} deployed`);
                  return distribution;
                })
              : Effect.gen(function* () {
                  yield* Effect.logInfo(
                    `CloudFront Distribution wait: ${distributionId} status=${distribution?.Status ?? "unknown"}`,
                  );
                  return yield* new DistributionPendingDeployment({
                    message: `Distribution ${distributionId} is not yet deployed`,
                  });
                }),
          ),
          Effect.retry({
            while: (error) => error._tag === "DistributionPendingDeployment",
            schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
          }),
        );
      });

      const getCurrent = Effect.fn(function* (distributionId: string) {
        yield* Effect.logInfo(
          `CloudFront Distribution read: loading distribution ${distributionId}`,
        );
        const distribution = yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
          Effect.map((response) => response.Distribution),
          Effect.catchTag("NoSuchDistribution", () => Effect.undefined),
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

      const getByCallerReference = Effect.fn(function* (callerReference: string) {
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
              .pipe(Effect.catchTag("NoSuchDistribution", () => Effect.undefined));

            if (config?.DistributionConfig?.CallerReference === callerReference) {
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

      const waitForDeletionReady = Effect.fn(function* (distributionId: string) {
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
          // Bound each poll: a single wedged HTTP read (stale keep-alive
          // socket) otherwise hangs the whole destroy — observed as a
          // disable-wait that logged one poll and then sat silent past a
          // 60-minute test budget. Timeout counts as "not ready yet" and
          // rides the same bounded retry.
          Effect.andThen(() =>
            getCurrent(distributionId).pipe(
              Effect.timeoutOrElse({
                duration: 30_000,
                orElse: () =>
                  Effect.fail(
                    new DistributionPendingDeletionReadiness({
                      message: `Timed out reading distribution ${distributionId} while waiting for deletion readiness`,
                    }),
                  ),
              }),
            ),
          ),
          Effect.flatMap(
            Effect.fn(function* (current) {
              if (!current) {
                yield* Effect.logInfo(
                  `CloudFront Distribution delete: ${distributionId} already absent while waiting`,
                );
                return undefined;
              }

              if (current.config.Enabled || current.distribution.Status !== "Deployed") {
                yield* Effect.logInfo(
                  `CloudFront Distribution delete: ${distributionId} not ready enabled=${current.config.Enabled} status=${current.distribution.Status}`,
                );
                return yield* new DistributionPendingDeletionReadiness({
                  message: `Distribution ${distributionId} is not yet ready for deletion`,
                });
              }

              yield* Effect.logInfo(
                `CloudFront Distribution delete: ${distributionId} ready for delete with etag=${current.etag ?? "missing"}`,
              );
              return current;
            }),
          ),
          Effect.retry({
            while: (error) => error._tag === "DistributionPendingDeletionReadiness",
            schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
          }),
        );
      });

      return {
        stables: ["distributionId", "distributionArn", "domainName", "hostedZoneId"],
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
        read: Effect.fn(function* ({ instanceId, output }) {
          // Without cached attributes, fall back to the deterministic
          // caller reference (= instanceId). A create interrupted during
          // its multi-minute deployment wait leaves a `creating` row with
          // no attributes; the engine asks `read` to recover it before
          // deleting, so returning `undefined` here would drop the row and
          // orphan the (already created) distribution.
          const current = output?.distributionId
            ? yield* getCurrent(output.distributionId)
            : yield* getByCallerReference(instanceId);
          if (!current) {
            return undefined;
          }

          return toAttrs(
            current.distribution,
            current.etag,
            current.tags,
            yield* resolveUrl(current.distribution),
          );
        }),
        // CloudFront is a global service (no region). Enumerate every
        // distribution in the account via the paginated `listDistributions`
        // op, then resolve each summary to the full `read`-shaped Attributes
        // (distribution + config + tags) so callers get a `delete`-ready item.
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* cloudfront.listDistributions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.DistributionList?.Items ?? []),
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
                  Effect.flatMap((current) =>
                    current
                      ? Effect.map(
                          resolveUrl(current.distribution),
                          (url) =>
                            toAttrs(current.distribution, current.etag, current.tags, url) as
                              | Distribution["Attributes"]
                              | undefined,
                        )
                      : Effect.undefined,
                  ),
                ),
              { concurrency: 10 },
            );

            return rows.filter((row): row is Distribution["Attributes"] => row !== undefined);
          }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news: _news,
          output,
          session,
          bindings,
        }) {
          // Fold bound aliases (see `DistributionBinding`) into the desired
          // props up front so both the create and update paths (`toConfig`)
          // attach them uniformly.
          const news: typeof _news = {
            ..._news,
            aliases: resolveEffectiveAliases(_news.aliases, bindings),
          };
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
                        if (created.Distribution?.ARN && Object.keys(desiredTags).length > 0) {
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
                        return yield* error;
                      }),
                ),
                Effect.map((created) => ({
                  distributionId: created.Distribution?.Id,
                  etag: created.ETag,
                  tags: desiredTags,
                })),
                Effect.catchTags({
                  DistributionAlreadyExists: () =>
                    Effect.gen(function* () {
                      yield* Effect.logInfo(
                        `CloudFront Distribution reconcile: callerReference=${callerReference} already exists, attempting recovery`,
                      );
                      const recovered = yield* getByCallerReference(callerReference);
                      if (!recovered?.distribution.Id) {
                        return yield* new DistributionConflict({
                          message: `CloudFront distribution with caller reference '${callerReference}' already exists but could not be recovered`,
                        });
                      }
                      return {
                        distributionId: recovered.distribution.Id,
                        etag: recovered.etag,
                        tags: recovered.tags,
                      };
                    }),
                  InvalidArgument: (
                    error,
                  ): Effect.Effect<
                    never,
                    cloudfront.InvalidArgument | DistributionFunctionAssociationPending
                  > =>
                    isFunctionAssociationPending(error)
                      ? Effect.logInfo(
                          "CloudFront Distribution reconcile: function association not yet ready, retrying",
                        ).pipe(
                          Effect.andThen(
                            Effect.fail(
                              new DistributionFunctionAssociationPending({
                                message: error.message ?? "CloudFront function association pending",
                              }),
                            ),
                          ),
                        )
                      : Effect.fail(error),
                }),
                Effect.retry({
                  while: (error) => error instanceof DistributionFunctionAssociationPending,
                  schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
                }),
              );

            if (!created.distributionId) {
              return yield* new DistributionUnexpectedResponse({
                message: "createDistribution returned no distribution",
              });
            }

            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: created ${created.distributionId} etag=${created.etag ?? "missing"}, waiting for deployment`,
            );
            const deployed = yield* waitForDeployment(created.distributionId);
            yield* Effect.logInfo(
              `CloudFront Distribution reconcile: deployed ${created.distributionId} domain=${deployed.DomainName}`,
            );
            yield* session.note(created.distributionId);
            return toAttrs(deployed, created.etag, created.tags, yield* resolveUrl(deployed));
          }

          // Sync config — diff observed config against desired and patch
          // via `updateDistribution` with the freshly observed ETag. We
          // keep the observed `CallerReference` because CloudFront does
          // not allow it to change, and fill every member the props don't
          // express from the observed config: UpdateDistribution replaces
          // the whole config and rejects requests with missing members
          // (see `mergeWithObservedConfig`).
          yield* Effect.logInfo(
            `CloudFront Distribution reconcile: updating config for ${observed.distribution.Id} with etag=${observed.etag ?? "missing"}`,
          );
          const updated = yield* cloudfront
            .updateDistribution({
              Id: observed.distribution.Id,
              IfMatch: observed.etag,
              DistributionConfig: mergeWithObservedConfig(
                toConfig(observed.config.CallerReference, news),
                observed.config,
              ),
            })
            .pipe(
              Effect.catchTag(
                "InvalidArgument",
                (
                  error,
                ): Effect.Effect<
                  never,
                  cloudfront.InvalidArgument | DistributionFunctionAssociationPending
                > =>
                  isFunctionAssociationPending(error)
                    ? Effect.logInfo(
                        "CloudFront Distribution reconcile: function association not yet ready, retrying",
                      ).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new DistributionFunctionAssociationPending({
                              message: error.message ?? "CloudFront function association pending",
                            }),
                          ),
                        ),
                      )
                    : Effect.fail(error),
              ),
              Effect.retry({
                while: (error) => error instanceof DistributionFunctionAssociationPending,
                schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
              }),
            );

          if (!updated.Distribution?.Id) {
            return yield* new DistributionUnexpectedResponse({
              message: "updateDistribution returned no distribution",
            });
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
          return toAttrs(deployed, updated.ETag, desiredTags, yield* resolveUrl(deployed));
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
  // Without a cache policy, CloudFront is in legacy mode and rejects the
  // request unless both ForwardedValues and MinTTL are present.
  ForwardedValues:
    behavior.forwardedValues ??
    (behavior.cachePolicyId === undefined
      ? { QueryString: false, Cookies: { Forward: "none" } }
      : undefined),
  MinTTL: toWireSeconds(behavior.minTtl) ?? (behavior.cachePolicyId === undefined ? 0 : undefined),
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
  GrpcConfig: behavior.grpcConfig ? { Enabled: behavior.grpcConfig.enabled } : undefined,
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
    !isVpcOrigin && (origin.s3Origin === true || origin.s3OriginConfig !== undefined);

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
          OriginReadTimeout: toWireSeconds(origin.vpcOriginConfig!.originReadTimeout),
          OriginKeepaliveTimeout: toWireSeconds(origin.vpcOriginConfig!.originKeepaliveTimeout),
        }
      : undefined,
    S3OriginConfig: isS3Origin
      ? {
          OriginAccessIdentity: origin.s3OriginConfig?.originAccessIdentity ?? "",
          OriginReadTimeout: toWireSeconds(origin.s3OriginConfig?.originReadTimeout),
        }
      : undefined,
    CustomOriginConfig:
      isVpcOrigin || isS3Origin
        ? undefined
        : {
            HTTPPort: origin.customOriginConfig?.httpPort ?? 80,
            HTTPSPort: origin.customOriginConfig?.httpsPort ?? 443,
            OriginProtocolPolicy: origin.customOriginConfig?.originProtocolPolicy ?? "https-only",
            OriginSslProtocols: {
              Quantity: (origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"]).length,
              Items: origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"],
            },
            OriginReadTimeout: toWireSeconds(origin.customOriginConfig?.originReadTimeout),
            OriginKeepaliveTimeout: toWireSeconds(
              origin.customOriginConfig?.originKeepaliveTimeout,
            ),
            IpAddressType: origin.customOriginConfig?.ipAddressType,
            OriginMtlsConfig: origin.customOriginConfig?.originMtlsConfig
              ? {
                  ClientCertificateArn:
                    origin.customOriginConfig.originMtlsConfig.clientCertificateArn,
                }
              : undefined,
          },
  };
};

/**
 * Recursively fills `undefined` members of `desired` from `observed`.
 * Defined values in `desired` always win; arrays are taken from `desired`
 * wholesale (item-level merging is the caller's concern).
 */
const fillUndefined = <T>(desired: T, observed: T): T => {
  if (desired === undefined) return observed;
  if (
    desired === null ||
    typeof desired !== "object" ||
    Array.isArray(desired) ||
    observed === null ||
    typeof observed !== "object" ||
    Array.isArray(observed)
  ) {
    return desired;
  }
  const out: Record<string, unknown> = {
    ...(desired as Record<string, unknown>),
  };
  const desiredObj = desired as Record<string, unknown>;
  for (const key of Object.keys(observed as Record<string, unknown>)) {
    // CloudFront list shapes pair `Quantity` with `Items`. A desired node
    // that declares a `Quantity` but no `Items` (e.g. a geo restriction of
    // `{ RestrictionType: "none", Quantity: 0 }`) is fully specified —
    // filling `Items` from the observed config would desynchronize the two
    // and CloudFront rejects the update with `InconsistentQuantities`.
    if (
      key === "Items" &&
      typeof desiredObj.Quantity === "number" &&
      desiredObj.Items === undefined
    ) {
      continue;
    }
    out[key] = fillUndefined(desiredObj[key], (observed as Record<string, unknown>)[key]);
  }
  return out as T;
};

/**
 * Completes a desired `DistributionConfig` with the freshly observed live
 * config before an `updateDistribution` call.
 *
 * CloudFront's `UpdateDistribution` replaces the ENTIRE distribution config:
 * any member missing from the request is rejected with `IllegalUpdate`
 * (observed in practice: "Default root object is missing for the resource",
 * "The 'OriginCustomHeaders' field is missing"). `toConfig` emits only the
 * members the props express, so updating a live distribution fails on every
 * member the props don't model — some of which (e.g. per-origin
 * `CustomHeaders`, per-behavior `TrustedSigners`) are nested inside
 * collections and not expressible as props at all.
 *
 * The standard CloudFront update pattern is read-modify-write, which the
 * delete path here already uses (`{ ...current.config, Enabled: false }`).
 * This applies the same idea to updates: desired values always win — the
 * declared props still fully control drift — and only `undefined` members
 * are carried over from the observed config. `Origins` and `CacheBehaviors`
 * items are additionally merged by identity (`Id` / `PathPattern`) so their
 * nested unexpressed members carry over too.
 *
 * Exported for unit tests.
 */
const originKind = (origin: cloudfront.Origin) =>
  origin.VpcOriginConfig ? "vpc" : origin.S3OriginConfig ? "s3" : "custom";

export const mergeWithObservedConfig = (
  desired: cloudfront.DistributionConfig,
  observed: cloudfront.DistributionConfig,
): cloudfront.DistributionConfig => {
  const merged = fillUndefined(desired, observed);
  if (merged.Origins?.Items && observed.Origins?.Items) {
    const observedOrigins = observed.Origins.Items;
    merged.Origins = {
      ...merged.Origins,
      Items: merged.Origins.Items.map((item) => {
        const current = observedOrigins.find((origin) => origin.Id === item.Id) ?? item;
        if (originKind(current) === originKind(item)) return fillUndefined(item, current);
        // An origin that changes kind (custom <-> S3 <-> VPC) under the same
        // id must not inherit the old kind's config or access control:
        // CloudFront rejects an origin carrying both.
        const {
          S3OriginConfig: _s3,
          CustomOriginConfig: _custom,
          VpcOriginConfig: _vpc,
          OriginAccessControlId: _oac,
          ...shared
        } = current;
        return fillUndefined(item, shared as cloudfront.Origin);
      }),
    };
  }
  if (merged.CacheBehaviors?.Items && observed.CacheBehaviors?.Items) {
    const observedBehaviors = observed.CacheBehaviors.Items;
    merged.CacheBehaviors = {
      ...merged.CacheBehaviors,
      Items: merged.CacheBehaviors.Items.map((item) =>
        fillUndefined(
          item,
          observedBehaviors.find((behavior) => behavior.PathPattern === item.PathPattern) ?? item,
        ),
      ),
    };
  }
  return merged;
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
          props.orderedCacheBehaviors as Array<DistributionBehavior & { pathPattern: string }>
        ).length,
        Items: (
          props.orderedCacheBehaviors as Array<DistributionBehavior & { pathPattern: string }>
        ).map((behavior) =>
          toBehavior(behavior as DistributionBehavior & { pathPattern: string }),
        ) as cloudfront.CacheBehavior[],
      }
    : undefined,
  OriginGroups: props.originGroups
    ? {
        Quantity: (props.originGroups as DistributionOriginGroup[]).length,
        Items: (props.originGroups as DistributionOriginGroup[]).map((group) => ({
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
        })),
      }
    : undefined,
  CustomErrorResponses: props.customErrorResponses
    ? {
        Quantity: (props.customErrorResponses as cloudfront.CustomErrorResponse[]).length,
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
        CloudFrontDefaultCertificate: (props.viewerCertificate as DistributionViewerCertificate)
          .cloudFrontDefaultCertificate,
        IAMCertificateId: (props.viewerCertificate as DistributionViewerCertificate)
          .iamCertificateId,
        ACMCertificateArn: (props.viewerCertificate as DistributionViewerCertificate)
          .acmCertificateArn,
        SSLSupportMethod: (props.viewerCertificate as DistributionViewerCertificate)
          .sslSupportMethod,
        MinimumProtocolVersion: (props.viewerCertificate as DistributionViewerCertificate)
          .minimumProtocolVersion,
        Certificate: (props.viewerCertificate as DistributionViewerCertificate).certificate,
        CertificateSource: (props.viewerCertificate as DistributionViewerCertificate)
          .certificateSource,
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

/**
 * The distribution's own URL.
 *
 * On AWS this is `https://` + the CloudFront domain name. The local emulator
 * has no such hostname — `*.cloudfront.net` resolves to nothing on a
 * developer's machine — so it serves each distribution's edge on a plain-HTTP
 * port of its own and reports which one. Asking it here (rather than having
 * every consumer interpolate a URL from `domainName`) is what keeps `url`
 * openable in both modes. Anything unexpected falls back to the AWS-shaped
 * URL: a missing edge port must never fail a reconcile.
 */
const resolveUrl = Effect.fn("AWS.CloudFront.Distribution.url")(function* (
  distribution: cloudfront.Distribution,
) {
  const awsUrl = `https://${distribution.DomainName}`;
  const env = yield* AWSEnvironment.current;
  const endpoint = env.endpoint;
  if (endpoint === undefined || !(yield* AWSEnvironment.isLocalEmulator)) {
    return awsUrl;
  }
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${endpoint}/_floci/cloudfront-edge/${distribution.Id}`);
    // A distribution legitimately has no edge port: the emulator binds one
    // opportunistically and stays Host-addressable when it can't, and the
    // endpoint 404s (with a JSON error body) for one it doesn't know yet.
    // `client.get` does not fail on 404, so every shape lands here — `null`,
    // an error object, or a port-less entry. Anything that isn't a numeric
    // `Port` means "no local edge", which is the AWS URL.
    const edge = (yield* response.json) as { Port?: number } | null;
    if (edge === null || typeof edge !== "object" || typeof edge.Port !== "number") {
      return awsUrl;
    }
    const host = yield* Effect.sync(() => new URL(endpoint).hostname);
    return `http://${host}:${edge.Port}`;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.provide(FetchHttpClient.layer),
    // `orElseSucceed` alone only covers the error channel. A malformed body
    // throws inside the generator, which Effect surfaces as a DEFECT — that
    // escaped the fallback and killed a reconcile with a raw TypeError.
    // Resolving a convenience URL must never be able to fail a deploy.
    Effect.catchCause(() => Effect.succeed(awsUrl)),
  );
});

const toAttrs = (
  distribution: cloudfront.Distribution,
  etag: string | undefined,
  tags: Record<string, string>,
  url: string,
): Distribution["Attributes"] => ({
  distributionId: distribution.Id,
  distributionArn: distribution.ARN,
  domainName: distribution.DomainName,
  url,
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
