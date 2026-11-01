import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type RegionTargetHttpsProxyProps = {
  /**
   * TargetHttpsProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetHttpsProxyName?: string;
  /**
   * Region the proxy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the resource. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute
   * RegionTargetHttpsProxy has no labels field).
   */
  description?: string;
  /**
   * Regional URL map this proxy routes to. Accepts a RegionUrlMap
   * self-link, a `projects/{project}/regions/{region}/urlMaps/{name}`
   * path, or the UrlMap name.
   */
  urlMap: string;
  /**
   * Regional SslCertificate URLs used to terminate HTTPS. Accepts
   * self-links, `projects/{project}/regions/{region}/sslCertificates/{name}`
   * paths, or certificate names. At least one is required.
   */
  sslCertificates?: string[];
  /**
   * Regional SslPolicy URL applied to client TLS. Empty string clears the
   * policy. Accepts a self-link, path, or policy name.
   */
  sslPolicy?: string;
  /**
   * HTTP keep-alive timeout in seconds after a response while idle.
   * Regional Application Load Balancers allow 5–600 (default 610).
   */
  httpKeepAliveTimeoutSec?: number;
  /**
   * Bind inbound traffic to the forwarding-rule address. Only applies when
   * the referencing forwarding rule uses `INTERNAL_SELF_MANAGED`.
   * @default false
   */
  proxyBind?: boolean;
  /**
   * networksecurity.ServerTlsPolicy URL used to authenticate inbound
   * traffic.
   */
  serverTlsPolicy?: string;
};

export type RegionTargetHttpsProxy = Resource<
  "GCP.Compute.RegionTargetHttpsProxy",
  RegionTargetHttpsProxyProps,
  {
    /** TargetHttpsProxy name. */
    targetHttpsProxyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached regional UrlMap. */
    urlMap: string;
    /** SslCertificate URLs. */
    sslCertificates: string[];
    /** SslPolicy URL, if set. */
    sslPolicy: string | undefined;
    /** HTTP keep-alive timeout in seconds, if set. */
    httpKeepAliveTimeoutSec: number | undefined;
    /** Whether Envoy inbound bind is enabled. */
    proxyBind: boolean;
    /** Server TLS policy URL, if set. */
    serverTlsPolicy: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetHttpsProxyId: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine target HTTPS proxy.
 *
 * Regional target HTTPS proxies terminate HTTPS for regional Application
 * Load Balancers. A forwarding rule points at the proxy; the proxy points
 * at a regional URL map and one or more regional SSL certificates.
 *
 * This resource maps to the `regionTargetHttpsProxies` collection (the
 * global `targetHttpsProxies` collection is `GCP.Compute.TargetHttpsProxy`).
 * Compute RegionTargetHttpsProxy has no labels field — Alchemy ownership
 * is stored in the description so nuke can find leaked proxies. Url map
 * and certificates update in place; name and region replace.
 *
 * ### Creating a Regional Target HTTPS Proxy
 * **Example:** Generated name in front of a regional URL map
 * ```typescript
 * const map = yield* GCP.Compute.RegionUrlMap("web", {
 *   region: "us-central1",
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * const cert = yield* GCP.Compute.RegionSslCertificate("tls", {
 *   region: "us-central1",
 *   certificate: pemCertificate,
 *   privateKey: pemPrivateKey,
 * });
 * const proxy = yield* GCP.Compute.RegionTargetHttpsProxy("https", {
 *   region: "us-central1",
 *   urlMap: map.urlMapName,
 *   sslCertificates: [cert.sslCertificateName],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionTargetHttpsProxy = Resource<RegionTargetHttpsProxy>(
  "GCP.Compute.RegionTargetHttpsProxy",
);

export class RegionTargetHttpsProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionTargetHttpsProxyNotResolved",
)<{
  targetHttpsProxyName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `h${generated}`.slice(0, 63);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const resourceTail = (value: string | undefined): string => lastSegment(value);

const toUrlMapRef = (
  project: string,
  region: string,
  urlMap: string,
): string => {
  if (urlMap.includes("/")) return urlMap;
  return `projects/${project}/regions/${region}/urlMaps/${urlMap}`;
};

const toSslCertRef = (
  project: string,
  region: string,
  cert: string,
): string => {
  if (cert.includes("/")) return cert;
  return `projects/${project}/regions/${region}/sslCertificates/${cert}`;
};

const toSslPolicyRef = (
  project: string,
  region: string,
  policy: string,
): string => {
  if (policy.length === 0 || policy.includes("/")) return policy;
  return `projects/${project}/regions/${region}/sslPolicies/${policy}`;
};

const sameResourceList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => {
  const a = [...(left ?? [])].map(resourceTail).sort();
  const b = [...(right ?? [])].map(resourceTail).sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
};

const toAttrs = (proxy: compute.TargetHttpsProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetHttpsProxyName: proxy.name ?? proxy.id ?? "",
    project,
    region: lastSegment(proxy.region).toLowerCase(),
    description: parsed.description,
    urlMap: proxy.urlMap ?? "",
    sslCertificates: [...(proxy.sslCertificates ?? [])],
    sslPolicy: proxy.sslPolicy,
    httpKeepAliveTimeoutSec: proxy.httpKeepAliveTimeoutSec,
    proxyBind: proxy.proxyBind === true,
    serverTlsPolicy: proxy.serverTlsPolicy,
    selfLink: proxy.selfLink,
    targetHttpsProxyId: proxy.id,
    fingerprint: proxy.fingerprint,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, region: string, targetHttpsProxy: string) =>
  compute
    .getRegionTargetHttpsProxies({ project, region, targetHttpsProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RegionTargetHttpsProxyProvider = () =>
  Provider.succeed(RegionTargetHttpsProxy, {
    stables: [
      "targetHttpsProxyName",
      "project",
      "region",
      "targetHttpsProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous =
        olds?.targetHttpsProxyName ?? output?.targetHttpsProxyName;
      const next = news.targetHttpsProxyName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      if (previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previous !== undefined && next !== undefined && previous !== next) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetHttpsProxyName = yield* toName(
        id,
        olds?.targetHttpsProxyName,
        output?.targetHttpsProxyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        targetHttpsProxyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetHttpsProxies
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetHttpsProxies ?? [])
              .filter((proxy) => (proxy.region ?? "").length > 0)
              .filter((proxy) => {
                const { labels } = parseDescription(proxy.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((proxy) => toAttrs(proxy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetHttpsProxyName = yield* toName(
        id,
        news.targetHttpsProxyName,
        output?.targetHttpsProxyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredUrlMap = toUrlMapRef(env.project, region, news.urlMap);
      const desiredCerts = (news.sslCertificates ?? []).map((cert) =>
        toSslCertRef(env.project, region, cert),
      );
      const desiredSslPolicy =
        news.sslPolicy !== undefined
          ? toSslPolicyRef(env.project, region, news.sslPolicy)
          : undefined;

      let current = yield* getByName(env.project, region, targetHttpsProxyName);

      if (current === undefined) {
        const body: compute.TargetHttpsProxy = {
          name: targetHttpsProxyName,
          description: desiredDescription,
          urlMap: desiredUrlMap,
        };
        if (desiredCerts.length > 0) {
          body.sslCertificates = desiredCerts;
        }
        if (desiredSslPolicy !== undefined) {
          body.sslPolicy = desiredSslPolicy;
        }
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.serverTlsPolicy !== undefined) {
          body.serverTlsPolicy = news.serverTlsPolicy;
        }
        yield* compute
          .insertRegionTargetHttpsProxies({
            project: env.project,
            region,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, region, targetHttpsProxyName);
      }

      if (current === undefined) {
        return yield* new RegionTargetHttpsProxyNotResolved({
          targetHttpsProxyName,
          region,
        });
      }

      if (resourceTail(current.urlMap) !== resourceTail(desiredUrlMap)) {
        yield* compute
          .setUrlMapRegionTargetHttpsProxies({
            project: env.project,
            region,
            targetHttpsProxy: targetHttpsProxyName,
            body: { urlMap: desiredUrlMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new RegionTargetHttpsProxyNotResolved({
            targetHttpsProxyName,
            region,
          });
        }
      }

      if (
        news.sslCertificates !== undefined &&
        !sameResourceList(current.sslCertificates, desiredCerts)
      ) {
        yield* compute
          .setSslCertificatesRegionTargetHttpsProxies({
            project: env.project,
            region,
            targetHttpsProxy: targetHttpsProxyName,
            body: { sslCertificates: desiredCerts },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new RegionTargetHttpsProxyNotResolved({
            targetHttpsProxyName,
            region,
          });
        }
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const keepAliveChanged =
        news.httpKeepAliveTimeoutSec !== undefined &&
        current.httpKeepAliveTimeoutSec !== news.httpKeepAliveTimeoutSec;
      const proxyBindChanged =
        news.proxyBind !== undefined &&
        (current.proxyBind === true) !== news.proxyBind;
      const serverTlsChanged =
        news.serverTlsPolicy !== undefined &&
        (current.serverTlsPolicy ?? "") !== news.serverTlsPolicy;
      const sslPolicyChanged =
        desiredSslPolicy !== undefined &&
        resourceTail(current.sslPolicy) !== resourceTail(desiredSslPolicy);

      if (
        descriptionChanged ||
        keepAliveChanged ||
        proxyBindChanged ||
        serverTlsChanged ||
        sslPolicyChanged
      ) {
        const body: compute.TargetHttpsProxy = {
          fingerprint: current.fingerprint,
          description: desiredDescription,
        };
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.serverTlsPolicy !== undefined) {
          body.serverTlsPolicy = news.serverTlsPolicy;
        }
        if (desiredSslPolicy !== undefined) {
          body.sslPolicy = desiredSslPolicy;
        }
        yield* compute
          .patchRegionTargetHttpsProxies({
            project: env.project,
            region,
            targetHttpsProxy: targetHttpsProxyName,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new RegionTargetHttpsProxyNotResolved({
            targetHttpsProxyName,
            region,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionTargetHttpsProxies({
          project: env.project,
          region,
          targetHttpsProxy: output.targetHttpsProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
