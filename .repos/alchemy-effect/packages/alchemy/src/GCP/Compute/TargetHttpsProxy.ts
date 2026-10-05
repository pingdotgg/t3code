import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
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

export type TargetHttpsProxyQuicOverride =
  compute.TargetHttpsProxyQuicOverrideEnum;
export type TargetHttpsProxyTlsEarlyData =
  compute.TargetHttpsProxyTlsEarlyDataEnum;

const DEFAULT_QUIC: TargetHttpsProxyQuicOverride = "NONE";

export type TargetHttpsProxyProps = {
  /**
   * TargetHttpsProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetHttpsProxyName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetHttpsProxy
   * has no labels field).
   */
  description?: string;
  /**
   * URL map this proxy routes to. Accepts a UrlMap self-link, a
   * `projects/{project}/global/urlMaps/{name}` path, or the UrlMap name.
   */
  urlMap: string;
  /**
   * SslCertificate URLs used to terminate HTTPS. Accepts self-links,
   * `projects/{project}/global/sslCertificates/{name}` paths, or
   * certificate names. At least one is required unless `certificateMap`
   * is set. Up to 15 classic certificates.
   */
  sslCertificates?: string[];
  /**
   * Certificate Manager map URL
   * (`//certificatemanager.googleapis.com/projects/{project}/locations/{location}/certificateMaps/{name}`).
   * When set, `sslCertificates` is ignored. Global external / classic
   * Application Load Balancers only.
   */
  certificateMap?: string;
  /**
   * SslPolicy URL applied to client TLS. Empty string clears the policy.
   */
  sslPolicy?: string;
  /**
   * QUIC override (`NONE`, `ENABLE`, `DISABLE`).
   * @default "NONE"
   */
  quicOverride?: TargetHttpsProxyQuicOverride | (string & {});
  /**
   * HTTP keep-alive timeout in seconds after a response while idle.
   * Global external Application Load Balancers: 5–1200. Not supported
   * on classic Application Load Balancers.
   */
  httpKeepAliveTimeoutSec?: number;
  /**
   * Whether TLS 1.3 0-RTT early data is accepted (`DISABLED`,
   * `PERMISSIVE`, `STRICT`, `UNRESTRICTED`).
   * @default "DISABLED"
   */
  tlsEarlyData?: TargetHttpsProxyTlsEarlyData | (string & {});
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
  /**
   * networksecurity.AuthorizationPolicy URL. Currently has no impact.
   */
  authorizationPolicy?: string;
};

export type TargetHttpsProxy = Resource<
  "GCP.Compute.TargetHttpsProxy",
  TargetHttpsProxyProps,
  {
    /** TargetHttpsProxy name. */
    targetHttpsProxyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached UrlMap. */
    urlMap: string;
    /** SslCertificate URLs. */
    sslCertificates: string[];
    /** Certificate Manager map URL, if set. */
    certificateMap: string | undefined;
    /** SslPolicy URL, if set. */
    sslPolicy: string | undefined;
    /** QUIC override policy. */
    quicOverride: string | undefined;
    /** HTTP keep-alive timeout in seconds, if set. */
    httpKeepAliveTimeoutSec: number | undefined;
    /** TLS 1.3 early-data mode, if set. */
    tlsEarlyData: string | undefined;
    /** Whether Envoy inbound bind is enabled. */
    proxyBind: boolean;
    /** Server TLS policy URL, if set. */
    serverTlsPolicy: string | undefined;
    /** Authorization policy URL, if set. */
    authorizationPolicy: string | undefined;
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
 * A global Compute Engine target HTTPS proxy.
 *
 * Target HTTPS proxies terminate HTTPS for global external Application
 * Load Balancers, classic Application Load Balancers, cross-region
 * internal Application Load Balancers, and Traffic Director. A forwarding
 * rule points at the proxy; the proxy points at a URL map and one or more
 * SSL certificates (or a Certificate Manager map).
 *
 * This resource maps to the global `targetHttpsProxies` collection
 * (`regionTargetHttpsProxies` is a separate resource). Compute
 * TargetHttpsProxy has no labels field — Alchemy ownership is stored in
 * the description so nuke can find leaked proxies.
 *
 * ### Creating a Target HTTPS Proxy
 * **Example:** Generated name in front of a URL map
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * const cert = yield* GCP.Compute.SslCertificate("tls", {
 *   certificate: pemCertificate,
 *   privateKey: pemPrivateKey,
 * });
 * const proxy = yield* GCP.Compute.TargetHttpsProxy("https", {
 *   urlMap: map.urlMapName,
 *   sslCertificates: [cert.sslCertificateName],
 * });
 * ```
 *
 * **Example:** Explicit name, QUIC, and description
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetHttpsProxy("https", {
 *   targetHttpsProxyName: "web-https",
 *   urlMap: map.selfLink,
 *   sslCertificates: [cert.selfLink],
 *   quicOverride: "ENABLE",
 *   description: "public https",
 * });
 * ```
 *
 * ### Updating a Target HTTPS Proxy
 * **Example:** Swap certificates and enable QUIC
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetHttpsProxy("https", {
 *   targetHttpsProxyName: "web-https",
 *   urlMap: map.urlMapName,
 *   sslCertificates: [nextCert.sslCertificateName],
 *   quicOverride: "ENABLE",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetHttpsProxy = Resource<TargetHttpsProxy>(
  "GCP.Compute.TargetHttpsProxy",
);

export class TargetHttpsProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetHttpsProxyNotResolved",
)<{
  targetHttpsProxyName: string;
}> {}

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

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const toUrlMapRef = (project: string, urlMap: string): string => {
  if (urlMap.includes("/")) return urlMap;
  return `projects/${project}/global/urlMaps/${urlMap}`;
};

const toSslCertRef = (project: string, cert: string): string => {
  if (cert.includes("/")) return cert;
  return `projects/${project}/global/sslCertificates/${cert}`;
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
    description: parsed.description,
    urlMap: proxy.urlMap ?? "",
    sslCertificates: [...(proxy.sslCertificates ?? [])],
    certificateMap: proxy.certificateMap,
    sslPolicy: proxy.sslPolicy,
    quicOverride: proxy.quicOverride,
    httpKeepAliveTimeoutSec: proxy.httpKeepAliveTimeoutSec,
    tlsEarlyData: proxy.tlsEarlyData,
    proxyBind: proxy.proxyBind === true,
    serverTlsPolicy: proxy.serverTlsPolicy,
    authorizationPolicy: proxy.authorizationPolicy,
    selfLink: proxy.selfLink,
    targetHttpsProxyId: proxy.id,
    fingerprint: proxy.fingerprint,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, targetHttpsProxy: string) =>
  compute
    .getTargetHttpsProxies({ project, targetHttpsProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TargetHttpsProxyProvider = () =>
  Provider.succeed(TargetHttpsProxy, {
    nuke: {
      dependsOn: ["GCP.Compute.UrlMap"],
    },
    stables: [
      "targetHttpsProxyName",
      "project",
      "targetHttpsProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous =
        olds?.targetHttpsProxyName ?? output?.targetHttpsProxyName;
      const next = news.targetHttpsProxyName;
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
      const existing = yield* getByName(env.project, targetHttpsProxyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listTargetHttpsProxies
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((proxy) => {
              const { labels } = parseDescription(proxy.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((proxy) => toAttrs(proxy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetHttpsProxyName = yield* toName(
        id,
        news.targetHttpsProxyName,
        output?.targetHttpsProxyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredUrlMap = toUrlMapRef(env.project, news.urlMap);
      const desiredCerts = (news.sslCertificates ?? []).map((cert) =>
        toSslCertRef(env.project, cert),
      );
      const desiredQuic = news.quicOverride ?? DEFAULT_QUIC;

      let current = yield* getByName(env.project, targetHttpsProxyName);

      if (current === undefined) {
        const body: compute.TargetHttpsProxy = {
          name: targetHttpsProxyName,
          description: desiredDescription,
          urlMap: desiredUrlMap,
        };
        if (desiredCerts.length > 0) {
          body.sslCertificates = desiredCerts;
        }
        if (news.certificateMap !== undefined) {
          body.certificateMap = news.certificateMap;
        }
        if (news.sslPolicy !== undefined) {
          body.sslPolicy = news.sslPolicy;
        }
        if (news.quicOverride !== undefined) {
          body.quicOverride = news.quicOverride;
        }
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        if (news.tlsEarlyData !== undefined) {
          body.tlsEarlyData = news.tlsEarlyData;
        }
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.serverTlsPolicy !== undefined) {
          body.serverTlsPolicy = news.serverTlsPolicy;
        }
        if (news.authorizationPolicy !== undefined) {
          body.authorizationPolicy = news.authorizationPolicy;
        }
        yield* compute
          .insertTargetHttpsProxies({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
      }

      if (current === undefined) {
        return yield* new TargetHttpsProxyNotResolved({
          targetHttpsProxyName,
        });
      }

      if (resourceTail(current.urlMap) !== resourceTail(desiredUrlMap)) {
        yield* compute
          .setUrlMapTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body: { urlMap: desiredUrlMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      if (
        news.sslCertificates !== undefined &&
        !sameResourceList(current.sslCertificates, desiredCerts)
      ) {
        yield* compute
          .setSslCertificatesTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body: { sslCertificates: desiredCerts },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      if (
        news.certificateMap !== undefined &&
        (current.certificateMap ?? "") !== news.certificateMap
      ) {
        yield* compute
          .setCertificateMapTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body: { certificateMap: news.certificateMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      if ((current.quicOverride ?? DEFAULT_QUIC) !== desiredQuic) {
        yield* compute
          .setQuicOverrideTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body: { quicOverride: desiredQuic },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      if (
        news.sslPolicy !== undefined &&
        (current.sslPolicy ?? "") !== news.sslPolicy
      ) {
        yield* compute
          .setSslPolicyTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body: { sslPolicy: news.sslPolicy },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const keepAliveChanged =
        news.httpKeepAliveTimeoutSec !== undefined &&
        current.httpKeepAliveTimeoutSec !== news.httpKeepAliveTimeoutSec;
      const tlsEarlyDataChanged =
        news.tlsEarlyData !== undefined &&
        (current.tlsEarlyData ?? "DISABLED") !== news.tlsEarlyData;
      const proxyBindChanged =
        news.proxyBind !== undefined &&
        (current.proxyBind === true) !== news.proxyBind;
      const serverTlsChanged =
        news.serverTlsPolicy !== undefined &&
        (current.serverTlsPolicy ?? "") !== news.serverTlsPolicy;
      const authorizationChanged =
        news.authorizationPolicy !== undefined &&
        (current.authorizationPolicy ?? "") !== news.authorizationPolicy;

      if (
        descriptionChanged ||
        keepAliveChanged ||
        tlsEarlyDataChanged ||
        proxyBindChanged ||
        serverTlsChanged ||
        authorizationChanged
      ) {
        const body: compute.TargetHttpsProxy = {
          fingerprint: current.fingerprint,
          description: desiredDescription,
        };
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        if (news.tlsEarlyData !== undefined) {
          body.tlsEarlyData = news.tlsEarlyData;
        }
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.serverTlsPolicy !== undefined) {
          body.serverTlsPolicy = news.serverTlsPolicy;
        }
        if (news.authorizationPolicy !== undefined) {
          body.authorizationPolicy = news.authorizationPolicy;
        }
        yield* compute
          .patchTargetHttpsProxies({
            project: env.project,
            targetHttpsProxy: targetHttpsProxyName,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpsProxyName);
        if (current === undefined) {
          return yield* new TargetHttpsProxyNotResolved({
            targetHttpsProxyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteTargetHttpsProxies({
          project: env.project,
          targetHttpsProxy: output.targetHttpsProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
