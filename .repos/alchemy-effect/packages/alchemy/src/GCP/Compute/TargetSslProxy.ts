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

export type TargetSslProxyProxyHeader = compute.TargetSslProxyProxyHeaderEnum;

const DEFAULT_PROXY_HEADER: TargetSslProxyProxyHeader = "NONE";

export type TargetSslProxyProps = {
  /**
   * TargetSslProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetSslProxyName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetSslProxy
   * has no labels field and no update API for description). Changing it
   * replaces the resource.
   */
  description?: string;
  /**
   * Backend service this proxy forwards decrypted traffic to. Accepts a
   * BackendService self-link, a
   * `projects/{project}/global/backendServices/{name}` path, or the
   * BackendService name. The backend service protocol must be `SSL`.
   */
  service: string;
  /**
   * SslCertificate URLs used to terminate SSL. Accepts self-links,
   * `projects/{project}/global/sslCertificates/{name}` paths, or
   * certificate names. At least one is required unless `certificateMap`
   * is set. Up to 15 classic certificates.
   */
  sslCertificates?: string[];
  /**
   * Certificate Manager map URL
   * (`//certificatemanager.googleapis.com/projects/{project}/locations/{location}/certificateMaps/{name}`).
   * When set, `sslCertificates` is ignored. Global SSL proxies only.
   */
  certificateMap?: string;
  /**
   * SslPolicy URL applied to client TLS. Empty string clears the policy.
   */
  sslPolicy?: string;
  /**
   * Proxy header appended before sending data to the backend (`NONE` or
   * `PROXY_V1`).
   * @default "NONE"
   */
  proxyHeader?: TargetSslProxyProxyHeader | (string & {});
};

export type TargetSslProxy = Resource<
  "GCP.Compute.TargetSslProxy",
  TargetSslProxyProps,
  {
    /** TargetSslProxy name. */
    targetSslProxyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached BackendService. */
    service: string;
    /** SslCertificate URLs. */
    sslCertificates: string[];
    /** Certificate Manager map URL, if set. */
    certificateMap: string | undefined;
    /** SslPolicy URL, if set. */
    sslPolicy: string | undefined;
    /** Proxy header prepended to backend connections. */
    proxyHeader: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetSslProxyId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine target SSL proxy.
 *
 * Target SSL proxies terminate SSL/TLS for Proxy Network Load Balancers
 * (SSL proxy). A forwarding rule points at the proxy; the proxy points at
 * a backend service (protocol `SSL`) and one or more SSL certificates (or
 * a Certificate Manager map).
 *
 * This resource maps to the global `targetSslProxies` collection. Compute
 * TargetSslProxy has no labels field — Alchemy ownership is stored in the
 * description so nuke can find leaked proxies. Description is immutable
 * after create.
 *
 * ### Creating a Target SSL Proxy
 * **Example:** Generated name in front of an SSL backend
 * ```typescript
 * const check = yield* GCP.Compute.HealthCheck("ssl", {
 *   type: "TCP",
 *   tcpHealthCheck: { port: 443 },
 * });
 * const backend = yield* GCP.Compute.BackendService("ssl", {
 *   protocol: "SSL",
 *   healthChecks: [check.selfLink],
 * });
 * const cert = yield* GCP.Compute.SslCertificate("tls", {
 *   certificate: pemCertificate,
 *   privateKey: pemPrivateKey,
 * });
 * const proxy = yield* GCP.Compute.TargetSslProxy("ssl", {
 *   service: backend.name,
 *   sslCertificates: [cert.sslCertificateName],
 * });
 * ```
 *
 * **Example:** Explicit name, PROXY protocol, and description
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetSslProxy("ssl", {
 *   targetSslProxyName: "web-ssl",
 *   service: backend.selfLink,
 *   sslCertificates: [cert.selfLink],
 *   proxyHeader: "PROXY_V1",
 *   description: "public ssl",
 * });
 * ```
 *
 * ### Updating a Target SSL Proxy
 * **Example:** Swap the backend and certificates
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetSslProxy("ssl", {
 *   targetSslProxyName: "web-ssl",
 *   service: nextBackend.name,
 *   sslCertificates: [nextCert.sslCertificateName],
 *   proxyHeader: "PROXY_V1",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetSslProxy = Resource<TargetSslProxy>(
  "GCP.Compute.TargetSslProxy",
);

export class TargetSslProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetSslProxyNotResolved",
)<{
  targetSslProxyName: string;
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
    return /^[a-z]/.test(generated) ? generated : `s${generated}`.slice(0, 63);
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

const toServiceRef = (project: string, service: string): string => {
  if (service.includes("/")) return service;
  return `projects/${project}/global/backendServices/${service}`;
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

const toAttrs = (proxy: compute.TargetSslProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetSslProxyName: proxy.name ?? proxy.id ?? "",
    project,
    description: parsed.description,
    service: proxy.service ?? "",
    sslCertificates: [...(proxy.sslCertificates ?? [])],
    certificateMap: proxy.certificateMap,
    sslPolicy: proxy.sslPolicy,
    proxyHeader: proxy.proxyHeader,
    selfLink: proxy.selfLink,
    targetSslProxyId: proxy.id,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, targetSslProxy: string) =>
  compute
    .getTargetSslProxies({ project, targetSslProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TargetSslProxyProvider = () =>
  Provider.succeed(TargetSslProxy, {
    stables: [
      "targetSslProxyName",
      "project",
      "targetSslProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.targetSslProxyName ?? output?.targetSslProxyName;
      const nextName = news.targetSslProxyName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousDescription = olds?.description ?? output?.description;
      if (
        (olds !== undefined || output !== undefined) &&
        previousDescription !== news.description
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetSslProxyName = yield* toName(
        id,
        olds?.targetSslProxyName,
        output?.targetSslProxyName,
      );
      const existing = yield* getByName(env.project, targetSslProxyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listTargetSslProxies
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
      const targetSslProxyName = yield* toName(
        id,
        news.targetSslProxyName,
        output?.targetSslProxyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredService = toServiceRef(env.project, news.service);
      const desiredCerts = (news.sslCertificates ?? []).map((cert) =>
        toSslCertRef(env.project, cert),
      );
      const desiredProxyHeader = news.proxyHeader ?? DEFAULT_PROXY_HEADER;

      let current = yield* getByName(env.project, targetSslProxyName);

      if (current === undefined) {
        const body: compute.TargetSslProxy = {
          name: targetSslProxyName,
          description: desiredDescription,
          service: desiredService,
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
        if (news.proxyHeader !== undefined) {
          body.proxyHeader = news.proxyHeader;
        }
        yield* compute
          .insertTargetSslProxies({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, targetSslProxyName);
      }

      if (current === undefined) {
        return yield* new TargetSslProxyNotResolved({
          targetSslProxyName,
        });
      }

      if (resourceTail(current.service) !== resourceTail(desiredService)) {
        yield* compute
          .setBackendServiceTargetSslProxies({
            project: env.project,
            targetSslProxy: targetSslProxyName,
            body: { service: desiredService },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetSslProxyName);
        if (current === undefined) {
          return yield* new TargetSslProxyNotResolved({
            targetSslProxyName,
          });
        }
      }

      if (
        news.sslCertificates !== undefined &&
        !sameResourceList(current.sslCertificates, desiredCerts)
      ) {
        yield* compute
          .setSslCertificatesTargetSslProxies({
            project: env.project,
            targetSslProxy: targetSslProxyName,
            body: { sslCertificates: desiredCerts },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetSslProxyName);
        if (current === undefined) {
          return yield* new TargetSslProxyNotResolved({
            targetSslProxyName,
          });
        }
      }

      if (
        news.certificateMap !== undefined &&
        (current.certificateMap ?? "") !== news.certificateMap
      ) {
        yield* compute
          .setCertificateMapTargetSslProxies({
            project: env.project,
            targetSslProxy: targetSslProxyName,
            body: { certificateMap: news.certificateMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetSslProxyName);
        if (current === undefined) {
          return yield* new TargetSslProxyNotResolved({
            targetSslProxyName,
          });
        }
      }

      if (
        (current.proxyHeader ?? DEFAULT_PROXY_HEADER) !== desiredProxyHeader
      ) {
        yield* compute
          .setProxyHeaderTargetSslProxies({
            project: env.project,
            targetSslProxy: targetSslProxyName,
            body: { proxyHeader: desiredProxyHeader },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetSslProxyName);
        if (current === undefined) {
          return yield* new TargetSslProxyNotResolved({
            targetSslProxyName,
          });
        }
      }

      if (
        news.sslPolicy !== undefined &&
        (current.sslPolicy ?? "") !== news.sslPolicy
      ) {
        yield* compute
          .setSslPolicyTargetSslProxies({
            project: env.project,
            targetSslProxy: targetSslProxyName,
            body: { sslPolicy: news.sslPolicy },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetSslProxyName);
        if (current === undefined) {
          return yield* new TargetSslProxyNotResolved({
            targetSslProxyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteTargetSslProxies({
          project: env.project,
          targetSslProxy: output.targetSslProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
