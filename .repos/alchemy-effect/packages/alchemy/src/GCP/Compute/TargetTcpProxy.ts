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

export type TargetTcpProxyProxyHeader = compute.TargetTcpProxyProxyHeaderEnum;
export type TargetTcpProxyLoadBalancingScheme =
  compute.TargetTcpProxyLoadBalancingSchemeEnum;

const DEFAULT_PROXY_HEADER: TargetTcpProxyProxyHeader = "NONE";

export type TargetTcpProxyProps = {
  /**
   * TargetTcpProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetTcpProxyName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetTcpProxy has
   * no labels field). The API cannot update this field — changing it
   * replaces the resource.
   */
  description?: string;
  /**
   * Backend service this proxy routes to. Accepts a BackendService
   * self-link, a `projects/{project}/global/backendServices/{name}` path,
   * or the BackendService name.
   */
  service: string;
  /**
   * Proxy header prepended before sending data to the backend (`NONE` or
   * `PROXY_V1`).
   * @default "NONE"
   */
  proxyHeader?: TargetTcpProxyProxyHeader | (string & {});
  /**
   * Bind inbound traffic to the forwarding-rule address. Only applies when
   * the referencing forwarding rule uses `INTERNAL_SELF_MANAGED`. Changing
   * it replaces the resource.
   * @default false
   */
  proxyBind?: boolean;
  /**
   * Load balancing scheme (`EXTERNAL`, `EXTERNAL_MANAGED`,
   * `INTERNAL_MANAGED`). Changing it replaces the resource.
   */
  loadBalancingScheme?: TargetTcpProxyLoadBalancingScheme | (string & {});
};

export type TargetTcpProxy = Resource<
  "GCP.Compute.TargetTcpProxy",
  TargetTcpProxyProps,
  {
    /** TargetTcpProxy name. */
    targetTcpProxyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached BackendService. */
    service: string;
    /** Proxy header prepended to backend connections. */
    proxyHeader: string | undefined;
    /** Whether Envoy inbound bind is enabled. */
    proxyBind: boolean;
    /** Load balancing scheme, if set. */
    loadBalancingScheme: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetTcpProxyId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine target TCP proxy.
 *
 * Target TCP proxies are referenced by global forwarding rules and point
 * at a backend service. They are a component of Proxy Network Load
 * Balancers (classic and global external). This resource maps to the
 * global `targetTcpProxies` collection (`regionTargetTcpProxies` is a
 * separate resource). Compute TargetTcpProxy has no labels field —
 * Alchemy ownership is stored in the description so nuke can find leaked
 * proxies.
 *
 * The API can update the backend service and proxy header in place.
 * `targetTcpProxyName`, `description`, `proxyBind`, and
 * `loadBalancingScheme` replace the resource.
 *
 * ### Creating a Target TCP Proxy
 * **Example:** Generated name in front of a TCP backend service
 * ```typescript
 * const backend = yield* GCP.Compute.BackendService("tcp", {
 *   protocol: "TCP",
 *   loadBalancingScheme: "EXTERNAL",
 * });
 * const proxy = yield* GCP.Compute.TargetTcpProxy("tcp", {
 *   service: backend.name,
 * });
 * ```
 *
 * **Example:** Explicit name, PROXY protocol, and description
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetTcpProxy("tcp", {
 *   targetTcpProxyName: "app-tcp",
 *   description: "public tcp frontend",
 *   service: backend.selfLink,
 *   proxyHeader: "PROXY_V1",
 * });
 * ```
 *
 * ### Updating a Target TCP Proxy
 * **Example:** Swap the backend service and enable PROXY protocol
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetTcpProxy("tcp", {
 *   targetTcpProxyName: "app-tcp",
 *   service: otherBackend.name,
 *   proxyHeader: "PROXY_V1",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetTcpProxy = Resource<TargetTcpProxy>(
  "GCP.Compute.TargetTcpProxy",
);

export class TargetTcpProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetTcpProxyNotResolved",
)<{
  targetTcpProxyName: string;
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
    return /^[a-z]/.test(generated) ? generated : `t${generated}`.slice(0, 63);
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

const toBackendServiceRef = (project: string, service: string): string => {
  if (service.includes("/")) return service;
  return `projects/${project}/global/backendServices/${service}`;
};

const toAttrs = (proxy: compute.TargetTcpProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetTcpProxyName: proxy.name ?? proxy.id ?? "",
    project,
    description: parsed.description,
    service: proxy.service ?? "",
    proxyHeader: proxy.proxyHeader,
    proxyBind: proxy.proxyBind === true,
    loadBalancingScheme: proxy.loadBalancingScheme,
    selfLink: proxy.selfLink,
    targetTcpProxyId: proxy.id,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, targetTcpProxy: string) =>
  compute
    .getTargetTcpProxies({ project, targetTcpProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TargetTcpProxyProvider = () =>
  Provider.succeed(TargetTcpProxy, {
    stables: [
      "targetTcpProxyName",
      "project",
      "targetTcpProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.targetTcpProxyName ?? output?.targetTcpProxyName;
      const next = news.targetTcpProxyName;
      if (previous !== undefined && next !== undefined && previous !== next) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (olds !== undefined) {
        if ((olds.description ?? "") !== (news.description ?? "")) {
          return { action: "replace" as const, deleteFirst: true };
        }
        if ((olds.proxyBind ?? false) !== (news.proxyBind ?? false)) {
          return { action: "replace" as const, deleteFirst: true };
        }
        if (
          (olds.loadBalancingScheme ?? "") !== (news.loadBalancingScheme ?? "")
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetTcpProxyName = yield* toName(
        id,
        olds?.targetTcpProxyName,
        output?.targetTcpProxyName,
      );
      const existing = yield* getByName(env.project, targetTcpProxyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listTargetTcpProxies
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
      const targetTcpProxyName = yield* toName(
        id,
        news.targetTcpProxyName,
        output?.targetTcpProxyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredService = toBackendServiceRef(env.project, news.service);
      const desiredProxyHeader = news.proxyHeader ?? DEFAULT_PROXY_HEADER;

      let current = yield* getByName(env.project, targetTcpProxyName);

      if (current === undefined) {
        const body: compute.TargetTcpProxy = {
          name: targetTcpProxyName,
          description: desiredDescription,
          service: desiredService,
        };
        if (news.proxyHeader !== undefined) {
          body.proxyHeader = news.proxyHeader;
        }
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.loadBalancingScheme !== undefined) {
          body.loadBalancingScheme = news.loadBalancingScheme;
        }
        yield* compute
          .insertTargetTcpProxies({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, targetTcpProxyName);
      }

      if (current === undefined) {
        return yield* new TargetTcpProxyNotResolved({ targetTcpProxyName });
      }

      if (resourceTail(current.service) !== resourceTail(desiredService)) {
        yield* compute
          .setBackendServiceTargetTcpProxies({
            project: env.project,
            targetTcpProxy: targetTcpProxyName,
            body: { service: desiredService },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetTcpProxyName);
        if (current === undefined) {
          return yield* new TargetTcpProxyNotResolved({
            targetTcpProxyName,
          });
        }
      }

      if (
        (current.proxyHeader ?? DEFAULT_PROXY_HEADER) !== desiredProxyHeader
      ) {
        yield* compute
          .setProxyHeaderTargetTcpProxies({
            project: env.project,
            targetTcpProxy: targetTcpProxyName,
            body: { proxyHeader: desiredProxyHeader },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetTcpProxyName);
        if (current === undefined) {
          return yield* new TargetTcpProxyNotResolved({
            targetTcpProxyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteTargetTcpProxies({
          project: env.project,
          targetTcpProxy: output.targetTcpProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
