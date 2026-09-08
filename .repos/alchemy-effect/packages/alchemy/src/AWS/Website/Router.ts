import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { Certificate } from "../ACM/Certificate.ts";
import {
  Distribution,
  type DistributionBehavior,
} from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { KeyValueStore } from "../CloudFront/KeyValueStore.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import { CachePolicy } from "../CloudFront/CachePolicy.ts";
import { MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID } from "../CloudFront/ManagedPolicies.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Records as Route53Records } from "../Route53/Records.ts";
import type { Bucket } from "../S3/Bucket.ts";
import { buildHostRedirectInjection, CF_ROUTER_INJECTION } from "./cfcode.ts";
import { normalizeWebsiteDomain, type RouterProps } from "./shared.ts";

/**
 * Shared CloudFront front door with KV-based dynamic routing.
 *
 * `Router` owns a single CloudFront distribution with a placeholder origin.
 * Routes are registered lazily via KV entries. A CloudFront Function reads the
 * KV store at the edge and dynamically sets the origin using
 * `cf.updateRequestOrigin()`.
 *
 * Sites register themselves by writing their file manifest and metadata into
 * the Router's KV store. The Router's CF function matches incoming requests to
 * routes by host pattern and path prefix, then delegates to `routeSite()` for
 * static site routing or directly sets URL/S3 origins.
 * ### Creating Routers
 * **Example:** Basic Router
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   domain: { name: "example.com", hostedZoneId },
 * });
 * ```
 *
 * ### Inline Routes
 * **Example:** URL And Bucket Routes
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   routes: {
 *     "/api/*": { url: api.functionUrl },
 *     "/*": { bucket: assetsBucket },
 *   },
 * });
 * ```
 *
 * ### Attaching Sites
 * **Example:** Serve A StaticSite Through The Router
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   invalidation: { paths: "all", wait: true },
 * });
 *
 * // The site registers itself in the Router's KV store; no new
 * // distribution is created.
 * const docs = yield* AWS.Website.StaticSite("DocsSite", {
 *   path: "./docs/dist",
 *   domain: {
 *     router,
 *     path: "/docs",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Router = Effect.fn("AWS.Website.Router")(
  function* (id: string, props: RouterProps) {
    const domain = normalizeWebsiteDomain(props.domain);

    if (domain && domain.dns === false && !domain.cert) {
      return yield* Effect.die(
        "Router domain configuration with `dns: false` requires `cert`.",
      );
    }
    if (props.cloudfrontUrl === false && !domain) {
      return yield* Effect.die(
        `"cloudfrontUrl: false" requires a "domain" — without one the Router would be unreachable (the CloudFront default domain is its only URL).`,
      );
    }
    if (domain?.redirects?.length && domain.name.includes("*")) {
      return yield* Effect.die(
        `"domain.redirects" requires a concrete (non-wildcard) "domain.name" to redirect to.`,
      );
    }

    // The managed certificate (when the Router owns one) doubles as a bind
    // target for attached-site hostnames — keep the resource handle distinct
    // from the viewer-certificate value, which may be a user-provided ARN.
    const managedCertificate =
      domain && !domain.cert
        ? yield* Certificate("Certificate", {
            domainName: domain.name,
            subjectAlternativeNames: [
              ...(domain.aliases ?? []),
              ...(domain.redirects ?? []),
            ],
            hostedZoneId: domain.hostedZoneId,
            tags: props.tags,
          })
        : undefined;
    const certificate =
      managedCertificate ??
      (domain?.cert ? { certificateArn: domain.cert } : undefined);

    const stack = yield* Stack;
    const stage = yield* Stage;
    const ns = yield* Namespace.CurrentNamespace;
    const fqn = ns ? toPath(ns).join("/") : id;
    const kvNamespace = createHash("md5")
      .update(`${stack.name}-${stage}-${fqn}`)
      .digest("hex")
      .substring(0, 4);

    const kvStore = yield* KeyValueStore("KvStore", {});

    const viewerRequest = yield* CloudFrontFunction("ViewerRequest", {
      comment: `${id} viewer request`,
      code: buildRouterRequestFunctionCode({
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
          code: buildRouterResponseFunctionCode(
            props.edge.viewerResponse.injection,
          ),
          keyValueStoreArns: props.edge.viewerResponse.keyValueStoreArn
            ? [props.edge.viewerResponse.keyValueStoreArn as any]
            : undefined,
        })
      : undefined;

    const functionAssociations: DistributionBehavior["functionAssociations"] = [
      {
        eventType: "viewer-request" as const,
        functionArn: viewerRequest.functionArn as any,
      },
      ...(viewerResponse
        ? [
            {
              eventType: "viewer-response" as const,
              functionArn: viewerResponse.functionArn as any,
            },
          ]
        : []),
    ];

    const inlineRouteEntries: Record<string, Input<string>> = {};
    const routeBuckets: Bucket[] = [];

    if (props.routes) {
      let routeIndex = 0;
      for (const [pattern, route] of Object.entries(props.routes)) {
        routeIndex++;
        const routeNs = createHash("md5")
          .update(`${stack.name}-${stage}-${fqn}:route:${routeIndex}`)
          .digest("hex")
          .substring(0, 4);

        if (typeof route === "string" || "url" in (route as any)) {
          const url = typeof route === "string" ? route : (route as any).url;
          const host = typeof url === "string" ? new URL(url).host : url;
          inlineRouteEntries[`${routeNs}:metadata`] = stringifyResolvedString(
            host,
            (resolvedHost) =>
              JSON.stringify({
                host: resolvedHost,
                origin: (route as any).origin,
                rewrite: (route as any).rewrite,
              }),
          );
          yield* KvRoutesUpdate(`Route${routeIndex}`, {
            store: kvStore.keyValueStoreArn as any,
            namespace: kvNamespace,
            key: "routes",
            entry: `url,${routeNs},,${normalizePattern(pattern)}`,
          });
        } else {
          const bucketRoute = route as any;
          if (typeof bucketRoute.bucket !== "string") {
            routeBuckets.push(bucketRoute.bucket as Bucket);
          }
          const bucketDomain =
            typeof bucketRoute.bucket === "string"
              ? bucketRoute.bucket
              : bucketRoute.bucket.bucketRegionalDomainName;
          inlineRouteEntries[`${routeNs}:metadata`] = stringifyResolvedString(
            bucketDomain,
            (resolvedDomain) =>
              JSON.stringify({
                domain: resolvedDomain,
                origin: bucketRoute.origin,
                rewrite: bucketRoute.rewrite,
              }),
          );
          yield* KvRoutesUpdate(`Route${routeIndex}`, {
            store: kvStore.keyValueStoreArn as any,
            namespace: kvNamespace,
            key: "routes",
            entry: `bucket,${routeNs},,${normalizePattern(pattern)}`,
          });
        }
      }
    }

    if (Object.keys(inlineRouteEntries).length > 0) {
      yield* KvEntries("InlineRouteEntries", {
        store: kvStore.keyValueStoreArn as any,
        namespace: kvNamespace,
        entries: inlineRouteEntries,
      });
    }

    // One behavior serves every attached site — static AND server-rendered
    // — so the cache policy must not cache responses that carry no
    // Cache-Control (SSR pages), while still honoring the immutable
    // Cache-Control the asset uploader sets. Managed CachingOptimized
    // would cache header-less SSR responses for a day. The
    // AllViewerExceptHostHeader origin-request policy forwards viewer
    // headers/cookies/query to server origins (required for Lambda URLs,
    // whose Host must stay the function URL's own domain).
    const cachePolicy = yield* CachePolicy("CachePolicy", {
      comment: `${id} router cache policy`,
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
    });

    const distribution = yield* Distribution("Distribution", {
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
            originReadTimeout: "20 seconds",
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
        cachePolicyId: cachePolicy.cachePolicyId,
        originRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
        functionAssociations,
      },
      viewerCertificate: certificate
        ? {
            acmCertificateArn: (certificate as any).certificateArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : undefined,
      tags: props.tags,
    });

    // Inline bucket routes are served through the router's distribution with
    // OAC-signed requests (see `setS3Origin` in cfcode.ts) — each bucket must
    // allow this distribution or every request 403s.
    yield* Effect.forEach(routeBuckets, (routeBucket) => {
      const bucketPolicy: PolicyStatement = {
        Effect: "Allow",
        Principal: {
          Service: "cloudfront.amazonaws.com",
        },
        Action: ["s3:GetObject"],
        Resource: [Output.interpolate`${routeBucket.bucketArn}/*` as any],
        Condition: {
          StringEquals: {
            "AWS:SourceArn": distribution.distributionArn as any,
          },
        },
      };
      return routeBucket.bind`AWS.S3.Policy(CloudFront, ${routeBucket})`({
        policyStatements: [bucketPolicy],
      });
    });

    const records =
      domain && domain.dns !== false
        ? yield* Effect.forEach(
            [
              domain.name,
              ...(domain.aliases ?? []),
              ...(domain.redirects ?? []),
            ],
            (name, index) =>
              Route53Record(`AliasRecord${index + 1}`, {
                // Optional — the Record provider infers the most specific
                // public zone containing `name` when omitted.
                hostedZoneId: domain.hostedZoneId,
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

    // Bind target for attached-site hostnames: a record set (initially
    // empty) that same-stack sites bind their concrete hostnames onto, each
    // becoming an A-alias record pointing at this distribution (see
    // `WebsiteRouterBindTargets`).
    const siteRecords =
      domain && domain.dns !== false
        ? yield* Route53Records("SiteAliasRecords", {
            // Optional — the Records provider infers the zone from the
            // first bound hostname when omitted.
            hostedZoneId: domain.hostedZoneId,
            type: "A",
            aliasTarget: {
              hostedZoneId: distribution.hostedZoneId,
              dnsName: distribution.domainName,
            },
          })
        : undefined;

    const invalidation =
      props.invalidation === false || !props.invalidation
        ? undefined
        : yield* Invalidation("Invalidation", {
            distributionId: distribution.distributionId,
            version: createHash("sha256")
              .update(JSON.stringify(inlineRouteEntries))
              .digest("hex"),
            wait: props.invalidation.wait,
            paths:
              props.invalidation.paths === "all" || !props.invalidation.paths
                ? ["/*"]
                : Array.isArray(props.invalidation.paths)
                  ? props.invalidation.paths
                  : ["/*"],
          });

    // Precedence: the canonical domain, then aliases in declaration order,
    // then the distribution's own URL (only while `cloudfrontUrl` is
    // enabled). Redirect hostnames never appear.
    //
    // `distribution.url` rather than an interpolated
    // `https://${distribution.domainName}`: the distribution knows its own
    // address, which is `https://{id}.cloudfront.net` on AWS and
    // `http://localhost:{port}` under `alchemy dev`, where that AWS hostname
    // resolves to nothing.
    const urls: Input<string>[] = domain
      ? [
          Output.interpolate`https://${domain.name}`,
          ...(domain.aliases ?? []).map((alias) => `https://${alias}`),
          ...(props.cloudfrontUrl !== false ? [distribution.url] : []),
        ]
      : [distribution.url];

    return {
      certificate,
      distribution,
      records,
      invalidation,
      kvStoreArn: kvStore.keyValueStoreArn as Input<string>,
      kvNamespace,
      distributionId: distribution.distributionId as Input<string>,
      distributionArn: distribution.distributionArn as Input<string>,
      /**
       * Same-stack bind targets for attached-site hostnames (see
       * `WebsiteRouterBindTargets` in shared.ts): a site declaring
       * `domain: { name, router }` binds its concrete hostnames onto the
       * distribution (alias), the managed certificate (SAN), and the
       * Route 53 record set. Only populated when the Router owns a
       * `domain` — without one there is no viewer certificate to cover
       * bound aliases.
       */
      bindTargets: domain
        ? {
            distribution,
            certificate: managedCertificate,
            records: siteRecords,
          }
        : undefined,
      /**
       * The most significant URL the Router serves at — always `urls[0]`.
       */
      url: urls[0],
      /**
       * Every URL the Router serves at, most significant first —
       * `[https://<domain.name>?, ...aliases, <CloudFront default
       * domain>?]` (the default domain only while `cloudfrontUrl` is
       * enabled). Redirect hostnames never appear — they serve no content.
       */
      urls,
    };
  },
  (effect, id: string, _props: RouterProps) => effect.pipe(Namespace.push(id)),
);

const buildRouterRequestFunctionCode = ({
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

  async function getRoutes() {
    var routerNS = "${kvNamespace}";
    var routes = [];
    try {
      var v = await cf.kvs().get(routerNS + ":routes");
      routes = JSON.parse(v);
      if (routes.parts) {
        var chunkPromises = [];
        for (var i = 0; i < routes.parts; i++) {
          chunkPromises.push(cf.kvs().get(routerNS + ":routes:" + i));
        }
        var chunks = await Promise.all(chunkPromises);
        routes = JSON.parse(chunks.join(""));
      }
    } catch (e) {}
    return routes;
  }

  async function matchRoute(routes) {
    var requestHost = event.request.headers.host.value;
    var requestHostWithEscapedDots = requestHost.replace(/\\./g, "\\\\.");
    var requestHostRegexPattern = "^" + requestHost + "$";
    var match;
    routes.forEach(function(r) {
      var parts = r.split(",");
      var type = parts[0];
      var routeNs = parts[1];
      var host = parts[2];
      var hostLength = host.length;
      var path = parts[3];
      var pathLength = path.length;
      if (match && (hostLength < match.hostLength || (hostLength === match.hostLength && pathLength < match.pathLength))) return;
      var hostMatches = host === "" || host === requestHostWithEscapedDots || (host.includes("*") && new RegExp(host).test(requestHostRegexPattern));
      if (!hostMatches) return;
      var pathMatches = event.request.uri.startsWith(path) && (event.request.uri === path || path.endsWith('/') || event.request.uri[path.length] === '/' || path === '/');
      if (!pathMatches) return;
      match = { type: type, routeNs: routeNs, host: host, hostLength: hostLength, path: path, pathLength: pathLength };
    });
    if (match) {
      try {
        var type = match.type;
        var routeNs = match.routeNs;
        var v = await cf.kvs().get(routeNs + ":metadata");
        return { type: type, routeNs: routeNs, metadata: JSON.parse(v) };
      } catch (e) {}
    }
  }

  var routes = await getRoutes();
  var route = await matchRoute(routes);
  if (!route) return event.request;
  if (route.metadata.rewrite) {
    var rw = route.metadata.rewrite;
    event.request.uri = event.request.uri.replace(new RegExp(rw.regex), rw.to);
  }
  if (route.type === "url") setUrlOrigin(route.metadata.host, route.metadata.origin);
  if (route.type === "bucket") setS3Origin(route.metadata.domain, route.metadata.origin);
  if (route.type === "site") {
    var response = await routeSite(route.routeNs, route.metadata);
    return response || event.request;
  }
  return event.request;
}`;

const buildRouterResponseFunctionCode = (userInjection?: string) =>
  `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  return event.response;
}`;

const normalizePattern = (pattern: string) => {
  if (pattern === "/" || pattern === "/*") return "/";
  return pattern.replace(/\/?\*$/, "");
};

const stringifyResolvedString = (
  value: Input<string>,
  build: (resolved: string) => string,
): Input<string> =>
  typeof value === "string"
    ? build(value)
    : Effect.isEffect(value)
      ? value.pipe(Effect.map((resolved) => build(resolved)))
      : value.pipe(Output.map((resolved) => build(resolved)));
