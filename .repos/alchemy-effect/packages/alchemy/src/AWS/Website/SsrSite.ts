import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as Construct from "../../Construct.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
  MANAGED_CACHING_OPTIMIZED_POLICY_ID,
} from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import type { Service } from "../ECS/Service.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Function } from "../Lambda/Function.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import type {
  SsrSiteRouteTargets,
  WebsiteDomainProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

export type SsrSiteServerOrigin =
  | {
      type: "lambda";
      function: Function;
      originProtocolPolicy?: "https-only";
    }
  | {
      type: "ecs";
      service: Service;
      originProtocolPolicy?: "http-only" | "https-only" | "match-viewer";
    }
  | {
      type: "url";
      url: Input<string>;
      originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
    };

export interface SsrSiteProps {
  /**
   * Dynamic server origin behind CloudFront.
   */
  server: SsrSiteServerOrigin;
  /**
   * Optional custom domain managed through Route 53.
   */
  domain?: WebsiteDomainProps;
  /**
   * Optional static asset bundle to serve from S3.
   */
  assets?: {
    /**
     * Local build output directory to upload.
     */
    sourcePath: Input<string>;
    /**
     * Optional deterministic S3 bucket name.
     */
    bucketName?: string;
    /**
     * Optional asset key prefix.
     */
    prefix?: string;
    /**
     * Path pattern that should be served from the asset bucket.
     * @default "/_assets/*"
     */
    pathPattern?: string;
    /**
     * Remove stale files under the prefix.
     * @default false
     */
    purge?: boolean;
    /**
     * Optional file overrides.
     */
    fileOptions?: AssetFileOption[];
  };
  /**
   * CloudFront cache policy ID for the dynamic server route.
   * @default CloudFront managed CachingDisabled
   */
  cachePolicyId?: Input<string>;
  /**
   * Cache invalidation behavior for asset updates.
   * @default false
   */
  invalidate?: false | WebsiteInvalidationProps;
  /**
   * Whether to create a standalone CloudFront distribution for the site.
   * Set this to `false` when the site should be routed through `AWS.Website.Router`.
   * @default true
   */
  cdn?: boolean;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

const serverUrlOf = (server: SsrSiteServerOrigin): Input<string> => {
  switch (server.type) {
    case "lambda":
      return Output.map((url: string | undefined) => {
        if (!url) {
          throw new Error(
            "SsrSite lambda origins require a function created with `url: true`.",
          );
        }
        return url;
      })(server.function.functionUrl as any) as any;
    case "ecs":
      return Output.map((url: string | undefined) => {
        if (!url) {
          throw new Error(
            "SsrSite ECS origins require a service created with `public: true`.",
          );
        }
        return url;
      })(server.service.url as any) as any;
    case "url":
      return server.url;
  }
};

const serverOriginOf = (server: SsrSiteServerOrigin): Input<string> =>
  Output.map((url: string) => new URL(url).hostname)(
    serverUrlOf(server) as any,
  ) as any;

/**
 * A server-rendered website behind CloudFront.
 *
 * `SsrSite` serves a dynamic origin behind CloudFront and can optionally split
 * immutable static assets into a private S3 bucket origin.
 *
 * @section Creating SSR Sites
 * @example Lambda URL Origin
 * ```typescript
 * const site = yield* SsrSite("App", {
 *   server: {
 *     type: "lambda",
 *     function: appFunction,
 *   },
 * });
 * ```
 *
 * @example SSR With Static Assets
 * ```typescript
 * const site = yield* SsrSite("App", {
 *   server: {
 *     type: "lambda",
 *     function: appFunction,
 *   },
 *   assets: {
 *     sourcePath: "./dist/client",
 *   },
 * });
 * ```
 */
export const SsrSite = Construct.fn(function* (
  id: string,
  props: SsrSiteProps,
) {
  const assetPattern = props.assets?.pathPattern ?? "/_assets/*";
  const serverUrl = serverUrlOf(props.server);
  const serverOriginHost = serverOriginOf(props.server);

  const assetBucket = props.assets
    ? yield* Bucket("AssetsBucket", {
        bucketName: props.assets.bucketName,
        tags: props.tags,
      })
    : undefined;

  const assetFiles =
    props.assets && assetBucket
      ? yield* AssetDeployment("AssetsFiles", {
          bucket: assetBucket,
          sourcePath: props.assets.sourcePath,
          prefix: props.assets.prefix,
          purge: props.assets.purge ?? false,
          fileOptions: props.assets.fileOptions,
        })
      : undefined;

  const assetOac =
    props.assets && assetBucket
      ? yield* OriginAccessControl("AssetsOriginAccessControl", {
          originType: "s3",
          description: `${id} SSR asset origin access control`,
        })
      : undefined;

  const routeTargets: SsrSiteRouteTargets = {
    server: {
      url: serverUrl,
      originProtocolPolicy: props.server.originProtocolPolicy ?? "https-only",
    },
    assets:
      assetBucket && assetOac
        ? {
            pattern: assetPattern,
            route: {
              bucket: assetBucket,
              originAccessControlId: assetOac.originAccessControlId,
              originPath: props.assets?.prefix,
              version: assetFiles?.version,
            },
          }
        : undefined,
  };

  if (props.cdn === false) {
    return {
      assetBucket,
      assetFiles,
      assetOriginAccessControl: assetOac,
      certificate: undefined,
      distribution: undefined,
      records: [],
      invalidation: undefined,
      routeTargets,
      url: undefined,
    };
  }

  if (props.domain && props.domain.dns === false && !props.domain.cert) {
    return yield* Effect.fail(
      new Error(
        "SsrSite domain configuration with `dns: false` requires `cert`.",
      ),
    );
  }

  const certificate =
    !props.domain || props.domain.cert
      ? props.domain?.cert
        ? { certificateArn: props.domain.cert }
        : undefined
      : yield* Certificate("Certificate", {
          domainName: props.domain.name,
          subjectAlternativeNames: [
            ...(props.domain.aliases ?? []),
            ...(props.domain.redirects ?? []),
          ],
          hostedZoneId: props.domain.hostedZoneId,
          tags: props.tags,
        });

  const distribution = yield* Distribution("Distribution", {
    aliases: props.domain
      ? [props.domain.name, ...(props.domain.aliases ?? [])]
      : undefined,
    origins: [
      {
        id: "server",
        domainName: serverOriginHost,
        customOriginConfig: {
          originProtocolPolicy:
            props.server.originProtocolPolicy ?? "https-only",
        },
      },
      ...(assetBucket && assetOac
        ? [
            {
              id: "assets",
              domainName: assetBucket.bucketRegionalDomainName,
              originPath: props.assets?.prefix,
              s3Origin: true,
              originAccessControlId: assetOac.originAccessControlId,
            },
          ]
        : []),
    ],
    defaultCacheBehavior: {
      targetOriginId: "server",
      viewerProtocolPolicy: "redirect-to-https",
      compress: true,
      allowedMethods: [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
      ],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: props.cachePolicyId ?? MANAGED_CACHING_DISABLED_POLICY_ID,
      originRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
    },
    orderedCacheBehaviors:
      assetBucket && assetOac
        ? [
            {
              pathPattern: assetPattern,
              targetOriginId: "assets",
              viewerProtocolPolicy: "redirect-to-https",
              compress: true,
              allowedMethods: ["GET", "HEAD", "OPTIONS"],
              cachedMethods: ["GET", "HEAD"],
              cachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
            },
          ]
        : undefined,
    viewerCertificate: certificate
      ? {
          acmCertificateArn: (certificate as any).certificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021",
        }
      : undefined,
    tags: props.tags,
  });

  if (assetBucket && assetOac) {
    const bucketPolicy: PolicyStatement = {
      Effect: "Allow",
      Principal: {
        Service: "cloudfront.amazonaws.com",
      },
      Action: ["s3:GetObject"],
      Resource: [Output.interpolate`${assetBucket.bucketArn}/*` as any],
      Condition: {
        StringEquals: {
          "AWS:SourceArn": distribution.distributionArn as any,
        },
      },
    };

    yield* assetBucket.bind`AWS.S3.Policy(${distribution}, ${assetBucket})`({
      policyStatements: [bucketPolicy],
    });
  }

  const records =
    props.domain?.hostedZoneId && props.domain.dns !== false
      ? yield* Effect.forEach(
          [
            props.domain.name,
            ...(props.domain.aliases ?? []),
            ...(props.domain.redirects ?? []),
          ],
          (name, index) =>
            Route53Record(`AliasRecord${index + 1}`, {
              hostedZoneId: props.domain!.hostedZoneId!,
              name,
              type: "A",
              aliasTarget: {
                hostedZoneId: distribution.hostedZoneId,
                dnsName: distribution.domainName,
              },
            }),
          { concurrency: "unbounded" },
        )
      : [];

  const invalidation =
    props.invalidate === false || !assetFiles
      ? undefined
      : yield* Invalidation("Invalidation", {
          distributionId: distribution.distributionId,
          version: assetFiles.version,
          wait: props.invalidate?.wait,
          paths:
            props.invalidate?.paths === "versioned"
              ? [assetPattern]
              : props.invalidate?.paths === "all" || !props.invalidate?.paths
                ? ["/*"]
                : props.invalidate.paths,
        });

  return {
    assetBucket,
    assetFiles,
    assetOriginAccessControl: assetOac,
    certificate,
    distribution,
    records,
    invalidation,
    routeTargets,
    url: props.domain
      ? Output.interpolate`https://${props.domain.name}`
      : Output.interpolate`https://${distribution.domainName}`,
  };
});
