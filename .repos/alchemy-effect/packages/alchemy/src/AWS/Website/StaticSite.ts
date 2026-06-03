import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Command } from "../../Build/Command.ts";
import * as Construct from "../../Construct.ts";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { KeyValueStore } from "../CloudFront/KeyValueStore.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import { MANAGED_CACHING_OPTIMIZED_POLICY_ID } from "../CloudFront/ManagedPolicies.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
} from "./cfcode.ts";
import type {
  StaticSiteAssetsProps,
  StaticSiteBuildProps,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

type StaticSiteDomainInput = string | WebsiteDomainProps;

export interface StaticSiteRouterAttachment {
  instance: {
    kvStoreArn: Input<string>;
    kvNamespace: Input<string>;
    distributionId: Input<string>;
    url: Input<string>;
  };
  domain?: string;
  path?: string;
}

export interface StaticSiteProps {
  /**
   * Path to the local site directory.
   * @default "."
   */
  path?: Input<string>;
  /**
   * Optional build configuration executed before upload.
   */
  build?: StaticSiteBuildProps;
  /**
   * Environment variables exposed to the build command.
   */
  environment?: Record<string, Input<string>>;
  /**
   * Static site asset upload configuration.
   */
  assets?: StaticSiteAssetsProps & {
    fileOptions?: AssetFileOption[];
  };
  /**
   * Optional custom domain.
   */
  domain?: StaticSiteDomainInput;
  /**
   * Serve this site through an existing Router instead of creating a standalone
   * CloudFront distribution.
   */
  router?: StaticSiteRouterAttachment;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Index page served for the site root.
   * @default "index.html"
   */
  indexPage?: string;
  /**
   * Error page returned for 403/404 requests.
   * When set, CloudFront customErrorResponses are created.
   */
  errorPage?: string;
  /**
   * Optional deterministic S3 bucket name for newly created buckets.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects before destroying created buckets.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * CloudFront invalidation behavior.
   * @default { paths: "all", wait: false }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

/**
 * Deploy a static website to S3 and CloudFront using KV-based edge routing.
 *
 * `StaticSite` uploads site files to a private S3 bucket, creates a CloudFront
 * KeyValueStore with a file manifest for edge routing, and optionally builds
 * the site first. Supports standalone distribution or composition with
 * `AWS.Website.Router`.
 *
 * @section Basic Sites
 * @example Simple Static Site
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./site",
 * });
 * ```
 *
 * @section Built Sites
 * @example Build A Vite App
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./frontend",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   environment: {
 *     VITE_API_URL: api.url,
 *   },
 * });
 * ```
 *
 * @section Router Composition
 * @example Serve Through A Router
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   router: {
 *     instance: router,
 *     path: "/docs",
 *   },
 * });
 * ```
 */
export const StaticSite = Construct.fn(function* (
  id: string,
  props: StaticSiteProps,
) {
  const domain = normalizeDomain(props.domain);
  const sitePath = (props.path ?? ".") as string;
  const indexPage = props.indexPage ?? "index.html";
  const assetPrefix = normalizePrefix(props.assets?.path);
  const assetRoutes = [...(props.assets?.routes ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeRoutePath);
  const invalidationProps =
    props.invalidation !== undefined
      ? props.invalidation
      : { paths: "all" as const, wait: false };

  if (props.router && props.domain) {
    return yield* Effect.die(
      `Cannot provide both "domain" and "router". Use the "domain" prop on the Router component.`,
    );
  }
  if (props.router && props.edge) {
    return yield* Effect.die(
      `Cannot provide both "edge" and "router". Use the "edge" prop on the Router component.`,
    );
  }

  const build = props.build
    ? yield* Command("Build", {
        command: props.build.command,
        cwd: sitePath,
        memo: {
          include: props.build.include,
          exclude: props.build.exclude,
          lockfile: props.build.lockfile,
        },
        outdir: props.build.output,
        env: props.environment,
      })
    : undefined;

  const uploadSourcePath = (build?.outdir ?? sitePath) as string;

  const providedBucket = props.assets?.bucket;
  const bucket =
    providedBucket ??
    (yield* Bucket("Bucket", {
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    }));

  const routerAttachment = props.router;
  const routerPathPrefix = routerAttachment?.path
    ? "/" + routerAttachment.path.replace(/^\//, "").replace(/\/$/, "")
    : undefined;

  const files = yield* AssetDeployment("Files", {
    bucket: bucket,
    sourcePath: uploadSourcePath,
    prefix: normalizeUploadPrefix(assetPrefix, routerPathPrefix),
    purge: props.assets?.purge ?? true,
    fileOptions: props.assets?.fileOptions,
    textEncoding: props.assets?.textEncoding,
  });

  const stack = yield* Stack;
  const stage = yield* Stage;
  const ns = yield* Namespace.CurrentNamespace;
  const fqn = ns ? toPath(ns).join("/") : id;
  const kvNamespace = createHash("md5")
    .update(`${stack.name}-${stage}-${fqn}`)
    .digest("hex")
    .substring(0, 4);

  const kvEntries = buildKvEntries(
    uploadSourcePath,
    bucket,
    assetPrefix,
    assetRoutes,
    indexPage,
    props.errorPage,
    routerPathPrefix,
  );

  let distributionId: Input<string>;
  let kvStoreArn: Input<string>;
  let distribution: Distribution | undefined;
  let prodUrl: Input<string> | undefined;

  if (routerAttachment) {
    kvStoreArn = routerAttachment.instance.kvStoreArn;
    distributionId = routerAttachment.instance.distributionId;
    const hostPattern = routerAttachment.domain
      ? routerAttachment.domain
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
      : undefined;
    yield* KvRoutesUpdate("RoutesUpdate", {
      store: kvStoreArn,
      namespace: routerAttachment.instance.kvNamespace as any,
      key: "routes",
      entry: [
        "site",
        kvNamespace,
        hostPattern ?? "",
        routerPathPrefix ?? "/",
      ].join(","),
    });
    prodUrl = routerAttachment.domain
      ? `https://${routerAttachment.domain}${routerPathPrefix ?? ""}`
      : Output.interpolate`${routerAttachment.instance.url}${routerPathPrefix ?? ""}`;
  } else {
    if (
      domain &&
      !domain.cert &&
      !domain.hostedZoneId &&
      domain.dns === false
    ) {
      return yield* Effect.die(
        "StaticSite domain configuration with `dns: false` requires `cert`.",
      );
    }

    const certificate =
      !domain || domain.cert
        ? domain?.cert
          ? { certificateArn: domain.cert }
          : undefined
        : yield* Certificate("Certificate", {
            domainName: domain.name,
            subjectAlternativeNames: [
              ...(domain.aliases ?? []),
              ...(domain.redirects ?? []),
            ],
            hostedZoneId: domain.hostedZoneId,
            tags: props.tags,
          });

    const kvStore = yield* KeyValueStore("KvStore", {});
    kvStoreArn = kvStore.keyValueStoreArn;

    const viewerRequest = yield* CloudFrontFunction("ViewerRequest", {
      comment: `${id} viewer request`,
      code: buildRequestFunctionCode({
        kvNamespace,
        userInjection: props.edge?.viewerRequest?.injection,
        blockCloudfrontUrl: !!domain,
      }),
      keyValueStoreArns: [kvStore.keyValueStoreArn],
    });

    const viewerResponse = props.edge?.viewerResponse
      ? yield* CloudFrontFunction("ViewerResponse", {
          comment: `${id} viewer response`,
          code: buildResponseFunctionCode(props.edge.viewerResponse.injection),
          keyValueStoreArns: props.edge.viewerResponse.keyValueStoreArn
            ? [props.edge.viewerResponse.keyValueStoreArn]
            : undefined,
        })
      : undefined;

    const functionAssociations = [
      {
        eventType: "viewer-request" as const,
        functionArn: viewerRequest.functionArn,
      },
      ...(viewerResponse
        ? [
            {
              eventType: "viewer-response" as const,
              functionArn: viewerResponse.functionArn,
            },
          ]
        : []),
    ];

    const errorPage = "/" + (props.errorPage ?? indexPage).replace(/^\//, "");
    const customErrorResponses = props.errorPage
      ? [
          {
            ErrorCode: 403,
            ResponseCode: "404",
            ResponsePagePath: errorPage,
            ErrorCachingMinTTL: 0,
          },
          {
            ErrorCode: 404,
            ResponseCode: "404",
            ResponsePagePath: errorPage,
            ErrorCachingMinTTL: 0,
          },
        ]
      : undefined;

    distribution = yield* Distribution("Distribution", {
      aliases: domain
        ? [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])]
        : undefined,
      origins: [
        {
          id: "default",
          domainName: "placeholder.alchemy.run",
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "https-only",
            originReadTimeout: 20,
            originSslProtocols: ["TLSv1.2"],
          },
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: "default",
        viewerProtocolPolicy: "redirect-to-https",
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
        compress: true,
        cachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
        functionAssociations,
      },
      customErrorResponses,
      viewerCertificate: certificate
        ? {
            acmCertificateArn: certificate.certificateArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : undefined,
      tags: props.tags,
    });

    const dist = distribution;
    distributionId = dist.distributionId;

    if (domain?.hostedZoneId && domain.dns !== false) {
      yield* Effect.forEach(
        [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
        (name, index) =>
          Route53Record(`AliasRecord${index + 1}`, {
            hostedZoneId: domain.hostedZoneId!,
            name,
            type: "A",
            aliasTarget: {
              hostedZoneId: dist.hostedZoneId,
              dnsName: dist.domainName,
            },
          }),
        { concurrency: "unbounded" },
      );
    }

    prodUrl = domain
      ? Output.interpolate`https://${domain.name}`
      : Output.interpolate`https://${dist.domainName}`;
  }

  yield* KvEntries("KvEntries", {
    store: kvStoreArn,
    namespace: kvNamespace,
    entries: kvEntries,
    purge: props.assets?.purge ?? true,
  });

  const invalidation =
    invalidationProps === false
      ? undefined
      : yield* Invalidation("Invalidation", {
          distributionId: distributionId,
          version: files.version,
          wait: invalidationProps?.wait,
          paths:
            invalidationProps?.paths === "all" || !invalidationProps?.paths
              ? ["/*"]
              : invalidationProps.paths === "versioned"
                ? [`/${indexPage.replace(/^\/+/, "")}`]
                : invalidationProps.paths,
        });

  return {
    bucket: bucket,
    build,
    files,
    distribution,
    invalidation,
    kvNamespace,
    url: prodUrl,
  };
});

const buildKvEntries = (
  outputPath: string,
  bucket: {
    bucketRegionalDomainName: Input<string>;
  },
  assetPrefix: string,
  assetRoutes: string[],
  indexPage: string,
  errorPage: string | undefined,
  routerPathPrefix: string | undefined,
): Record<string, Input<string>> => {
  const entries: Record<string, Input<string>> = {};
  const dirs: string[] = [];
  const expandDirs = [".well-known"];

  const processDir = (childPath = "", level = 0) => {
    let currentPath: string;
    try {
      currentPath = path.join(outputPath, childPath);
    } catch {
      return;
    }
    let items: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      items = readdirSync(currentPath, { withFileTypes: true }) as any;
    } catch {
      return;
    }
    for (const item of items) {
      const name = String(item.name);
      if (item.isFile()) {
        const filePath = path.posix.join("/", childPath, name);
        entries[filePath] = "s3";
      } else if (item.isDirectory()) {
        if (level === 0 && expandDirs.includes(name)) {
          processDir(path.join(childPath, name), level + 1);
        } else {
          dirs.push(path.posix.join("/", childPath, name));
        }
      }
    }
  };
  processDir();

  const errorPagePath = "/" + (errorPage ?? indexPage).replace(/^\//, "");
  const bucketDomain = bucket.bucketRegionalDomainName;
  const metadata: Omit<KvSiteMetadata, "s3"> & {
    s3: Omit<KvSiteMetadata["s3"], "domain">;
  } = {
    base:
      routerPathPrefix && routerPathPrefix !== "/"
        ? routerPathPrefix
        : undefined,
    custom404: errorPage ? undefined : errorPagePath,
    errorResponseCode: errorPage ? 404 : undefined,
    s3: {
      dir: assetPrefix ? "/" + assetPrefix : "",
      routes: [...assetRoutes, ...dirs],
    },
  };

  entries["metadata"] = stringifyResolvedString(bucketDomain, (domain) =>
    JSON.stringify({
      ...metadata,
      s3: {
        ...metadata.s3,
        domain,
      },
    }),
  );

  return entries;
};

interface KvSiteMetadata {
  base?: string;
  custom404?: string;
  errorResponseCode?: number;
  s3: {
    domain: string;
    dir: string;
    routes: string[];
  };
}

const stringifyResolvedString = (
  value: Input<string>,
  build: (resolved: string) => string,
): Input<string> =>
  typeof value === "string"
    ? build(value)
    : Effect.isEffect(value)
      ? value.pipe(Effect.map((resolved) => build(resolved)))
      : value.pipe(Output.map((resolved) => build(resolved)));

const buildRequestFunctionCode = ({
  kvNamespace,
  userInjection,
  blockCloudfrontUrl,
}: {
  kvNamespace: string;
  userInjection?: string;
  blockCloudfrontUrl: boolean;
}) => `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  ${blockCloudfrontUrl ? CF_BLOCK_CLOUDFRONT_URL_INJECTION : ""}
  ${CF_ROUTER_INJECTION}

  const kvNamespace = "${kvNamespace}";

  let metadata;
  try {
    const v = await cf.kvs().get(kvNamespace + ":metadata");
    metadata = JSON.parse(v);
  } catch (e) {}

  const response = await routeSite(kvNamespace, metadata);
  return response || event.request;
}`;

const buildResponseFunctionCode = (
  userInjection?: string,
) => `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  return event.response;
}`;

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const normalizeUploadPrefix = (
  assetPrefix: string,
  routerPathPrefix: string | undefined,
) => {
  const parts = [assetPrefix, routerPathPrefix?.replace(/^\//, "")].filter(
    Boolean,
  );
  return parts.join("/") || "";
};

const normalizeRoutePath = (value: string) =>
  `/${value.replace(/^\/+|\/+$/g, "")}`;

const normalizeDomain = (
  domain: StaticSiteProps["domain"],
): WebsiteDomainProps | undefined =>
  typeof domain === "string" ? { name: domain } : domain;
