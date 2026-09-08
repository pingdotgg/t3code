import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { isResource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { CachePolicy } from "../CloudFront/CachePolicy.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { KeyValueStore } from "../CloudFront/KeyValueStore.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_OPTIMIZED_POLICY_ID,
} from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import { buildHostRedirectInjection, CF_ROUTER_INJECTION } from "./cfcode.ts";
import { asRouterDomain, registerDevRouterRoute } from "./DevRouterRoute.ts";
import {
  normalizeWebsiteDomain,
  type StaticSiteBuildProps,
  type WebsiteAssetsConfig,
  type WebsiteDomainProps,
  type WebsiteEdgeProps,
  type WebsiteInvalidationProps,
  type WebsiteRouterDomainProps,
  type WebsiteStandaloneDomainProps,
} from "./shared.ts";

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
   * Static site asset upload configuration.
   */
  assets?: WebsiteAssetsConfig;
  /**
   * Optional custom domain. A string is shorthand for `{ name }`; `null`
   * explicitly clears a previously set domain. Set `domain.router` to
   * serve the site through an existing `AWS.Website.Router` instead of a
   * standalone CloudFront distribution.
   */
  domain?: string | WebsiteDomainProps | null;
  /**
   * Serve the site at its CloudFront default domain
   * (`https://dxxxx.cloudfront.net`). The default domain cannot be removed
   * from a distribution, so `false` is emulated at the edge: the generated
   * viewer-request CloudFront Function 301s requests that arrive on the
   * default domain to `https://<domain.name>` (path and query preserved),
   * and the default domain is excluded from the `urls` output.
   *
   * Requires `domain` when `false` (the site would be unreachable). Not
   * applicable to Router-attached sites (`domain.router`) — they own no
   * distribution.
   * @default true
   */
  cloudfrontUrl?: boolean;
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
   * Serve this site as a single-page application: any request that does not
   * match an uploaded file is answered with the `indexPage` and a `200`
   * status so client-side routing can take over.
   *
   * This is also the fallback behavior when neither `spa` nor `errorPage`
   * is set. Setting `spa: true` makes the intent explicit and guards
   * against accidentally combining it with `errorPage`.
   *
   * Mutually exclusive with `errorPage` (a static site returns a real
   * `404`; a SPA serves the app shell).
   * @default false
   */
  spa?: boolean;
  /**
   * Error page returned for 403/404 requests.
   * When set, CloudFront customErrorResponses are created and misses return
   * a real `404` status. Mutually exclusive with `spa`.
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
  /**
   * Local dev configuration. When `alchemy dev` runs, the build/upload is
   * skipped and `command` is spawned as a long-lived child process tied to
   * the stack's scope. Alchemy does not proxy or interpret the process —
   * the dev server's own URL (e.g. `http://localhost:5173`) is what you
   * open in the browser.
   *
   * @example
   * ```typescript
   * AWS.Website.StaticSite("App", {
   *   path: "./app",
   *   build: { command: "npm run build", output: "dist" },
   *   dev: { command: "npm run dev" },
   * });
   * ```
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to
     * {@link StaticSiteProps.path} (the site directory), or
     * `process.cwd()` if neither is set.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}, merged on top of
     * `process.env`. `Redacted` values stay out of logs and state, so put
     * secrets here rather than interpolating them into {@link command}.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from the
     * stdout of the dev command.
     */
    url?: string;
  };
}

/**
 * Deploy a static website to S3 and CloudFront using KV-based edge routing.
 *
 * `StaticSite` uploads site files to a private S3 bucket, creates a CloudFront
 * KeyValueStore with a file manifest for edge routing, and optionally builds
 * the site first. Supports standalone distribution or composition with
 * `AWS.Website.Router`.
 * ### Basic Sites
 * **Example:** Simple Static Site
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./site",
 * });
 * ```
 *
 * ### Built Sites
 * **Example:** Build A Vite App
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./frontend",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *     env: {
 *       VITE_API_URL: api.url,
 *     },
 *   },
 * });
 * ```
 *
 * ### Single-Page Applications
 * **Example:** SPA With Client-Side Routing
 * ```typescript
 * // Misses fall back to index.html with a 200 so the client router
 * // can handle the path.
 * const site = yield* StaticSite("App", {
 *   path: "./app",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   spa: true,
 * });
 * ```
 *
 * ### Custom Domains
 * **Example:** Site With A Route 53 Domain
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./site",
 *   domain: {
 *     name: "www.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Router Composition
 * **Example:** Serve Through A Router
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   domain: {
 *     router,
 *     path: "/docs",
 *   },
 * });
 * ```
 *
 * **Example:** Host-Matched Router Attachment
 * ```typescript
 * // The site serves for docs.example.com on the router. On a same-stack
 * // router that owns a domain, this declaration alone provisions the
 * // hostname end-to-end: the site binds it onto the router's distribution
 * // (alias), certificate (SAN), and Route 53 record set. Wildcard
 * // patterns and cross-stack router refs register KV host-matching only —
 * // those hostnames must be covered by the router's own domain.
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   domain: {
 *     name: "docs.example.com",
 *     router,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    // Mirrors the Cloudflare Website composites: during `alchemy dev` with
    // a `dev.command`, the site is the external dev server (spawned in the
    // dev sidecar so it survives user-code HMR) and no cloud resources are
    // declared; `Alchemy.remote()` opts back into the full live deployment.
    const isLocal = ctx.dev && remoted !== true;

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd:
          props.dev.cwd ??
          (typeof props.path === "string" ? props.path : undefined),
        env: props.dev.env,
      });
      const devUrl = Output.map(dev.url, (url) => url ?? props.dev?.url);
      // A Router-attached site registers with the Router in dev exactly as it
      // does live — same resource types, same ids, same route entries — with
      // the local dev server standing in for the S3 origin.
      const routerDomain = asRouterDomain(normalizeWebsiteDomain(props.domain));
      const kvNamespace = routerDomain
        ? yield* registerDevRouterRoute(routerDomain, devUrl)
        : undefined;
      return {
        bucket: undefined,
        build: undefined,
        files: undefined,
        distribution: undefined,
        invalidation: undefined,
        kvNamespace,
        url: devUrl,
        urls: [devUrl],
      };
    }

    return yield* makeKvSite(id, props);
  }).pipe(Namespace.push(id));

/**
 * Dynamic server origin for {@link makeKvSite} — the KV metadata gains a
 * `servers` entry so requests that match no uploaded file are forwarded to
 * the server instead of a static fallback.
 * @internal
 */
export interface KvSiteServerOptions {
  /**
   * Hostname of the dynamic server origin (e.g. a Lambda Function URL
   * host). Requests that miss the file manifest are forwarded here with
   * `x-forwarded-host` set.
   */
  serverHost: Input<string>;
  /**
   * Optional dedicated image-optimization origin: requests whose path
   * starts with `route` (e.g. `/_next/image`) are forwarded to `host`
   * instead of the server origin (see `metadata.image` in cfcode.ts).
   */
  image?: {
    route: string;
    host: Input<string>;
  };
}

/**
 * Shared implementation behind `StaticSite` and the SSR framework
 * composites (`AWS.Website.Nuxt`, ...): S3 + CloudFront + KV-manifest edge
 * routing, optionally with a dynamic server origin for misses.
 * @internal
 */
export const makeKvSite = Effect.fn("AWS.Website.KvSite")(function* (
  id: string,
  props: StaticSiteProps,
  server?: KvSiteServerOptions,
) {
  const domain = normalizeWebsiteDomain(props.domain);
  const routerDomain = domain?.router
    ? (domain as WebsiteRouterDomainProps)
    : undefined;
  const standaloneDomain =
    domain && !domain.router
      ? (domain as WebsiteStandaloneDomainProps)
      : undefined;
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

  if (routerDomain && props.edge) {
    return yield* Effect.die(
      `Cannot provide both "edge" and "domain.router". Use the "edge" prop on the Router component.`,
    );
  }
  if (routerDomain && props.cloudfrontUrl !== undefined) {
    return yield* Effect.die(
      `"cloudfrontUrl" does not apply to a Router-attached site ("domain.router" is set): the site owns no distribution. Set "cloudfrontUrl" on the Router instead.`,
    );
  }
  if (props.cloudfrontUrl === false && !standaloneDomain) {
    return yield* Effect.die(
      `"cloudfrontUrl: false" requires a "domain" — without one the site would be unreachable (the CloudFront default domain is its only URL).`,
    );
  }
  if (routerDomain?.aliases?.length && !routerDomain.name) {
    return yield* Effect.die(
      `"domain.aliases" requires "domain.name" on a Router-attached site.`,
    );
  }
  if (
    routerDomain?.redirects?.length &&
    (!routerDomain.name || routerDomain.name.includes("*"))
  ) {
    return yield* Effect.die(
      `"domain.redirects" requires a concrete (non-wildcard) "domain.name" to redirect to.`,
    );
  }
  if (
    standaloneDomain?.redirects?.length &&
    standaloneDomain.name.includes("*")
  ) {
    return yield* Effect.die(
      `"domain.redirects" requires a concrete (non-wildcard) "domain.name" to redirect to.`,
    );
  }
  if (props.spa && props.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }
  if (server && (props.spa || props.errorPage)) {
    return yield* Effect.die(
      `A site with a server origin routes misses to the server; "spa" and "errorPage" do not apply.`,
    );
  }

  const build = props.build
    ? yield* Command.Build("Build", {
        command: props.build.command,
        cwd: sitePath,
        memo: {
          include: props.build.include,
          exclude: props.build.exclude,
          lockfile: props.build.lockfile,
        },
        outdir: props.build.output,
        env: props.build.env,
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

  const routerPathPrefix = routerDomain?.path
    ? "/" + routerDomain.path.replace(/^\//, "").replace(/\/$/, "")
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

  // Standalone distributions carry the asset prefix as the default
  // origin's `originPath` (so error-page fetches that bypass the edge
  // function still resolve); router-attached sites prefix at the edge via
  // the KV metadata instead.
  const s3MetadataDir = routerDomain && assetPrefix ? "/" + assetPrefix : "";

  const kvEntries = buildKvEntries({
    files,
    bucketDomain: bucket.bucketRegionalDomainName as Input<string>,
    s3Dir: s3MetadataDir,
    assetRoutes,
    indexPage,
    errorPage: props.errorPage,
    routerPathPrefix,
    redirect:
      routerDomain?.redirects?.length && routerDomain.name
        ? { hosts: routerDomain.redirects, to: routerDomain.name }
        : undefined,
    serverHost: server?.serverHost,
    imageRoute: server?.image?.route,
    imageHost: server?.image?.host,
  });

  let distributionId: Input<string>;
  let kvStoreArn: Input<string>;
  let distribution: Distribution | undefined;
  let urls: Input<string>[];

  if (routerDomain) {
    const routerRef = routerDomain.router;
    kvStoreArn = routerRef.kvStoreArn;
    distributionId = routerRef.distributionId;
    // One KV route entry per host pattern: the canonical name (or the
    // match-any-host "" pattern), each alias, and each redirect hostname
    // (so redirected requests still match this site's route — the edge
    // function then 301s them from the site's KV metadata).
    const hostPatterns: [id: string, pattern: string | undefined][] = [
      ["RoutesUpdate", routerDomain.name],
      ...(routerDomain.aliases ?? []).map((alias, index): [string, string] => [
        `RoutesUpdateAlias${index + 1}`,
        alias,
      ]),
      ...(routerDomain.redirects ?? []).map(
        (redirect, index): [string, string] => [
          `RoutesUpdateRedirect${index + 1}`,
          redirect,
        ],
      ),
    ];
    yield* Effect.forEach(
      hostPatterns,
      ([routeId, pattern]) =>
        KvRoutesUpdate(routeId, {
          store: kvStoreArn,
          namespace: routerRef.kvNamespace as any,
          key: "routes",
          entry: [
            "site",
            kvNamespace,
            pattern ? toHostPatternRegex(pattern) : "",
            routerPathPrefix ?? "/",
          ].join(","),
        }),
      { concurrency: "unbounded" },
    );
    // Site→Router hostname binding: this site's concrete hostnames are
    // bound onto the Router's distribution (alias), managed certificate
    // (SAN — a change replaces the certificate create-first), and Route 53
    // record set, so the declaration here alone fully provisions the
    // hostname. Wildcard patterns bind nothing concrete, and cross-stack
    // Router refs carry no `bindTargets` (bindings are same-stack) — in
    // both cases the site registers KV host-matching only and the
    // hostname must be covered by the Router's own `domain`.
    const concreteHostnames = [
      ...(routerDomain.name && !routerDomain.name.includes("*")
        ? [routerDomain.name]
        : []),
      ...(routerDomain.aliases ?? []).filter((alias) => !alias.includes("*")),
      ...(routerDomain.redirects ?? []),
    ];
    const bindTargets = routerRef.bindTargets;
    if (bindTargets && concreteHostnames.length > 0) {
      if (bindTargets.distribution && isResource(bindTargets.distribution)) {
        yield* bindTargets.distribution.bind`AWS.Website.Site(${fqn})`({
          aliases: concreteHostnames,
        });
      }
      if (bindTargets.certificate && isResource(bindTargets.certificate)) {
        yield* bindTargets.certificate.bind`AWS.Website.Site(${fqn})`({
          subjectAlternativeNames: concreteHostnames,
        });
      }
      if (bindTargets.records && isResource(bindTargets.records)) {
        yield* bindTargets.records.bind`AWS.Website.Site(${fqn})`({
          names: concreteHostnames,
        });
      }
    }
    // Host-matched attachment: the site's own hostnames (the router's
    // CloudFront URL never serves it — KV host-match). Path-only
    // attachment: derived from the router's primary URL, inheriting the
    // router's precedence (including its `cloudfrontUrl` choice).
    urls = routerDomain.name
      ? [
          `https://${routerDomain.name}${routerPathPrefix ?? ""}`,
          ...(routerDomain.aliases ?? []).map(
            (alias) => `https://${alias}${routerPathPrefix ?? ""}`,
          ),
        ]
      : [Output.interpolate`${routerRef.url}${routerPathPrefix ?? ""}`];
  } else {
    const domain = standaloneDomain;
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
        hostRedirect: domain
          ? {
              to: domain.name,
              hosts: domain.redirects ?? [],
              cloudfrontDefault: props.cloudfrontUrl === false,
            }
          : undefined,
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
    const customErrorResponses =
      props.errorPage && !server
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

    // Server-backed sites share one behavior between S3 assets and the
    // dynamic origin, so the cache policy must not cache responses that
    // carry no Cache-Control (SSR pages) while still honoring the
    // immutable Cache-Control the asset uploader sets. Managed
    // CachingOptimized would cache header-less SSR responses for a day.
    const serverCachePolicy = server
      ? yield* CachePolicy("ServerCachePolicy", {
          comment: `${id} server cache policy`,
          minTTL: 0,
          defaultTTL: 0,
          maxTTL: "365 days",
          parametersInCacheKeyAndForwardedToOrigin: {
            EnableAcceptEncodingGzip: true,
            EnableAcceptEncodingBrotli: true,
            QueryStringsConfig: { QueryStringBehavior: "all" },
            HeadersConfig: { HeaderBehavior: "none" },
            CookiesConfig: { CookieBehavior: "none" },
          },
        })
      : undefined;

    // The default origin is real (not a placeholder): static sites point
    // at the bucket through an OAC so requests that bypass the edge
    // function's origin switch — CloudFront's custom-error-page fetches
    // in particular — still resolve; server-backed sites point at the
    // server so misses stream from it even if the function is bypassed.
    const oac = server
      ? undefined
      : yield* OriginAccessControl("OriginAccessControl", {
          originType: "s3",
          description: `${id} origin access control`,
        });

    distribution = yield* Distribution("Distribution", {
      aliases: domain
        ? [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])]
        : undefined,
      origins: [
        server
          ? {
              id: "default",
              domainName: server.serverHost,
              customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: "https-only" as const,
                originReadTimeout: "20 seconds",
                originSslProtocols: ["TLSv1.2"],
              },
            }
          : {
              id: "default",
              domainName: bucket.bucketRegionalDomainName,
              s3Origin: true,
              originAccessControlId: oac!.originAccessControlId,
              originPath: assetPrefix ? "/" + assetPrefix : undefined,
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
        cachePolicyId: serverCachePolicy
          ? serverCachePolicy.cachePolicyId
          : MANAGED_CACHING_OPTIMIZED_POLICY_ID,
        originRequestPolicyId: server
          ? MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID
          : undefined,
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

    if (domain && domain.dns !== false) {
      yield* Effect.forEach(
        [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
        (name, index) =>
          Route53Record(`AliasRecord${index + 1}`, {
            // Optional — the Record provider infers the most specific
            // public zone containing `name` when omitted.
            hostedZoneId: domain.hostedZoneId,
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

    // Precedence: the canonical domain, then aliases in declaration
    // order, then the CloudFront default domain (only while
    // `cloudfrontUrl` is enabled). Redirect hostnames never appear.
    //
    // `dist.url` rather than an interpolated
    // `https://${dist.domainName}` (same as Router): the distribution
    // knows its own address, which is `https://{id}.cloudfront.net` on
    // AWS and `http://localhost:{port}` under `alchemy dev`, where that
    // AWS hostname resolves to nothing.
    urls = domain
      ? [
          Output.interpolate`https://${domain.name}`,
          ...(domain.aliases ?? []).map((alias) => `https://${alias}`),
          ...(props.cloudfrontUrl !== false ? [dist.url] : []),
        ]
      : [dist.url];
  }

  // The edge router signs S3 origin requests with OAC (sigv4, see
  // `setS3Origin` in cfcode.ts), so the bucket must allow the serving
  // distribution — without this policy every request 403s.
  const servingDistributionArn = routerDomain
    ? routerDomain.router.distributionArn
    : distribution!.distributionArn;
  const bucketPolicy: PolicyStatement = {
    Effect: "Allow",
    Principal: {
      Service: "cloudfront.amazonaws.com",
    },
    Action: ["s3:GetObject"],
    Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
    Condition: {
      StringEquals: {
        "AWS:SourceArn": servingDistributionArn as any,
      },
    },
  };
  yield* bucket.bind`AWS.S3.Policy(CloudFront, ${bucket})`({
    policyStatements: [bucketPolicy],
  });

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
    /**
     * The most significant URL the site serves at — always `urls[0]`.
     */
    url: urls[0],
    /**
     * Every URL that serves this site, most significant first —
     * `[https://<domain.name>?, ...aliases, <CloudFront default domain>?]`
     * (the default domain only while `cloudfrontUrl` is enabled).
     * Router-attached sites list their own hostnames (host-matched) or
     * the router's URL plus `domain.path` (path-only). Redirect
     * hostnames never appear — they serve no content.
     */
    urls,
  };
});

/**
 * Derive the CloudFront KV routing entries from the *uploaded* file list
 * (the `AssetDeployment`'s `files` attribute) so the manifest always
 * reflects exactly what landed in S3 — including build outputs that do not
 * exist at plan time.
 */
const buildKvEntries = (args: {
  files: { files: Output.Output<string[]> };
  bucketDomain: Input<string>;
  s3Dir: string;
  assetRoutes: string[];
  indexPage: string;
  errorPage: string | undefined;
  routerPathPrefix: string | undefined;
  redirect: { hosts: string[]; to: string } | undefined;
  serverHost: Input<string> | undefined;
  imageRoute: string | undefined;
  imageHost: Input<string> | undefined;
}): Input<Record<string, string>> =>
  Output.map(
    ([fileList, bucketDomain, serverHost, imageHost]: [
      string[] | undefined,
      string,
      string | undefined,
      string | undefined,
    ]) => {
      const entries: Record<string, string> = {};
      for (const file of fileList ?? []) {
        entries[`/${file}`] = "s3";
      }
      const errorPagePath =
        "/" + (args.errorPage ?? args.indexPage).replace(/^\//, "");
      const metadata: KvSiteMetadata = {
        base:
          args.routerPathPrefix && args.routerPathPrefix !== "/"
            ? args.routerPathPrefix
            : undefined,
        custom404:
          serverHost !== undefined || args.errorPage
            ? undefined
            : errorPagePath,
        errorResponseCode:
          serverHost === undefined && args.errorPage ? 404 : undefined,
        s3: {
          domain: bucketDomain,
          dir: args.s3Dir,
          routes: args.assetRoutes,
        },
        servers: serverHost !== undefined ? [[serverHost]] : undefined,
        image:
          args.imageRoute !== undefined && imageHost !== undefined
            ? { route: args.imageRoute, host: imageHost }
            : undefined,
        redirect: args.redirect,
      };
      entries["metadata"] = JSON.stringify(metadata);
      return entries;
    },
  )(
    Output.all(
      args.files.files,
      Output.asOutput(args.bucketDomain as any),
      Output.asOutput(args.serverHost as any),
      Output.asOutput(args.imageHost as any),
    ) as Output.Output<
      [string[] | undefined, string, string | undefined, string | undefined]
    >,
  );

interface KvSiteMetadata {
  base?: string | undefined;
  custom404?: string | undefined;
  errorResponseCode?: number | undefined;
  s3: {
    domain: string;
    dir: string;
    routes: string[];
  };
  /**
   * Server origin hosts (`[[host, lat?, lon?], ...]`) the edge router
   * forwards misses to — see `findNearestServer` in cfcode.ts.
   */
  servers?: Array<Array<string>> | undefined;
  /**
   * Dedicated image-optimization origin: requests whose path starts with
   * `route` are forwarded to `host` — see `metadata.image` in cfcode.ts.
   */
  image?: { route: string; host: string } | undefined;
  /**
   * Router-attached redirect hostnames: matched requests whose `Host` is
   * in `hosts` are 301'd to `https://<to>` (path + query preserved) — see
   * the `metadata.redirect` check in `routeSite` in cfcode.ts.
   */
  redirect?: { hosts: string[]; to: string } | undefined;
}

const buildRequestFunctionCode = ({
  kvNamespace,
  userInjection,
  hostRedirect,
}: {
  kvNamespace: string;
  userInjection?: string;
  hostRedirect?: {
    to: string;
    hosts: string[];
    cloudfrontDefault: boolean;
  };
}) => `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  ${
    hostRedirect
      ? buildHostRedirectInjection({
          to: hostRedirect.to,
          hosts: hostRedirect.hosts,
          cloudfrontDefault: hostRedirect.cloudfrontDefault,
        })
      : ""
  }
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

/**
 * Convert a host pattern (`docs.example.com`, `*.example.com`) into the
 * escaped regex fragment stored in the Router's KV route table (matched by
 * the router's edge function).
 */
const toHostPatternRegex = (pattern: string) =>
  pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
