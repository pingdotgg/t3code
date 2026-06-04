import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as Construct from "../../Construct.ts";
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
import { MANAGED_CACHING_OPTIMIZED_POLICY_ID } from "../CloudFront/ManagedPolicies.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
} from "./cfcode.ts";
import type { RouterProps } from "./shared.ts";

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
 *
 * @section Creating Routers
 * @example Basic Router
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   domain: { name: "example.com", hostedZoneId },
 * });
 * ```
 *
 * @section Inline Routes
 * @example URL And Bucket Routes
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   routes: {
 *     "/*": { url: api.functionUrl },
 *   },
 * });
 * ```
 */
export const Router = Construct.fn(function* (id: string, props: RouterProps) {
  const domain = props.domain;

  if (domain && domain.dns === false && !domain.cert) {
    return yield* Effect.die(
      "Router domain configuration with `dns: false` requires `cert`.",
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
      blockCloudfrontUrl: !!domain,
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

  const distribution = yield* Distribution("Distribution", {
    aliases: domain
      ? [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])]
      : undefined,
    origins: [
      {
        id: "default",
        domainName: "placeholder.sst.dev",
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
    viewerCertificate: certificate
      ? {
          acmCertificateArn: (certificate as any).certificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021",
        }
      : undefined,
    tags: props.tags,
  });

  const records =
    domain?.hostedZoneId && domain.dns !== false
      ? yield* Effect.forEach(
          [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
          (name, index) =>
            Route53Record(`AliasRecord${index + 1}`, {
              hostedZoneId: domain.hostedZoneId!,
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

  return {
    certificate,
    distribution,
    records,
    invalidation,
    kvStoreArn: kvStore.keyValueStoreArn as Input<string>,
    kvNamespace,
    distributionId: distribution.distributionId as Input<string>,
    url: domain
      ? Output.interpolate`https://${domain.name}`
      : Output.interpolate`https://${distribution.domainName}`,
  };
});

const buildRouterRequestFunctionCode = ({
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
