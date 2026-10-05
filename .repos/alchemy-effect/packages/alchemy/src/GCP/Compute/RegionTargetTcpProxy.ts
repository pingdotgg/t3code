import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import type {
  TargetTcpProxyLoadBalancingScheme,
  TargetTcpProxyProxyHeader,
} from "./TargetTcpProxy.ts";

const DEFAULT_PROXY_HEADER: TargetTcpProxyProxyHeader = "NONE";

export type RegionTargetTcpProxyProps = {
  /**
   * TargetTcpProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetTcpProxyName?: string;
  /**
   * Region the proxy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the resource. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute RegionTargetTcpProxy
   * has no labels field). The regional API cannot update this field —
   * changing it replaces the resource.
   */
  description?: string;
  /**
   * Regional backend service this proxy routes to. Accepts a
   * RegionBackendService self-link, a
   * `projects/{project}/regions/{region}/backendServices/{name}` path, or
   * the BackendService name. Changing it replaces the resource.
   */
  service: string;
  /**
   * Proxy header prepended before sending data to the backend (`NONE` or
   * `PROXY_V1`). Changing it replaces the resource.
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
   * Load balancing scheme (`INTERNAL_MANAGED`, `EXTERNAL_MANAGED`).
   * Changing it replaces the resource.
   */
  loadBalancingScheme?: TargetTcpProxyLoadBalancingScheme | (string & {});
};

export type RegionTargetTcpProxy = Resource<
  "GCP.Compute.RegionTargetTcpProxy",
  RegionTargetTcpProxyProps,
  {
    /** TargetTcpProxy name. */
    targetTcpProxyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
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
 * A regional Compute Engine target TCP proxy.
 *
 * Regional target TCP proxies are referenced by regional forwarding rules
 * and point at a regional backend service. They are a component of
 * regional proxy Network Load Balancers. This resource maps to the
 * `regionTargetTcpProxies` collection (the global `targetTcpProxies`
 * collection is `GCP.Compute.TargetTcpProxy`). Compute RegionTargetTcpProxy
 * has no labels field and no in-place update API (`setBackendService` exists
 * only on the global collection). Alchemy ownership is stored in the
 * description so nuke can find leaked proxies. Changing the backend,
 * proxy header, description, `proxyBind`, or load-balancing scheme
 * deletes and recreates the proxy so the observed backend always matches.
 *
 * ### Creating a Regional Target TCP Proxy
 * **Example:** Generated name in front of a TCP backend service
 * ```typescript
 * const backend = yield* GCP.Compute.RegionBackendService("tcp", {
 *   region: "us-central1",
 *   protocol: "TCP",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 * });
 * const proxy = yield* GCP.Compute.RegionTargetTcpProxy("tcp", {
 *   region: "us-central1",
 *   service: backend.name,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionTargetTcpProxy = Resource<RegionTargetTcpProxy>(
  "GCP.Compute.RegionTargetTcpProxy",
);

export class RegionTargetTcpProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionTargetTcpProxyNotResolved",
)<{
  targetTcpProxyName: string;
  region: string;
}> {}

export class RegionTargetTcpProxyStillExists extends Data.TaggedError(
  "GCP.Compute.RegionTargetTcpProxyStillExists",
)<{
  targetTcpProxyName: string;
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

const resourceTail = (value: string | undefined): string => lastSegment(value);

const toBackendServiceRef = (
  project: string,
  region: string,
  service: string,
): string => {
  if (service.includes("/")) return service;
  return `projects/${project}/regions/${region}/backendServices/${service}`;
};

const toAttrs = (proxy: compute.TargetTcpProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetTcpProxyName: proxy.name ?? proxy.id ?? "",
    project,
    region: lastSegment(proxy.region).toLowerCase(),
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

const getByName = (project: string, region: string, targetTcpProxy: string) =>
  compute
    .getRegionTargetTcpProxies({ project, region, targetTcpProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (
  project: string,
  region: string,
  targetTcpProxyName: string,
) =>
  getByName(project, region, targetTcpProxyName).pipe(
    Effect.flatMap((proxy) =>
      proxy === undefined
        ? Effect.void
        : Effect.fail(
            new RegionTargetTcpProxyStillExists({
              targetTcpProxyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionTargetTcpProxyStillExists",
      times: 18,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const immutableChanged = (
  news: RegionTargetTcpProxyProps,
  olds: RegionTargetTcpProxyProps | undefined,
  output: RegionTargetTcpProxy["Attributes"] | undefined,
) => {
  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) return true;
  const previousService = resourceTail(olds?.service ?? output?.service);
  const nextService = resourceTail(news.service);
  if (
    previousService.length > 0 &&
    nextService.length > 0 &&
    previousService !== nextService
  ) {
    return true;
  }
  const previousHeader =
    olds?.proxyHeader ?? output?.proxyHeader ?? DEFAULT_PROXY_HEADER;
  const nextHeader = news.proxyHeader ?? DEFAULT_PROXY_HEADER;
  if (previousHeader !== nextHeader) return true;
  const previousBind = olds?.proxyBind ?? output?.proxyBind ?? false;
  if ((news.proxyBind ?? false) !== previousBind) return true;
  const previousScheme =
    olds?.loadBalancingScheme ?? output?.loadBalancingScheme ?? "";
  if ((news.loadBalancingScheme ?? "") !== previousScheme) return true;
  return false;
};

export const RegionTargetTcpProxyProvider = () =>
  Provider.succeed(RegionTargetTcpProxy, {
    stables: [
      "targetTcpProxyName",
      "project",
      "region",
      "targetTcpProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous = olds?.targetTcpProxyName ?? output?.targetTcpProxyName;
      const next = news.targetTcpProxyName ?? previous;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;
      const nameChanged =
        previous !== undefined && next !== undefined && previous !== next;
      if (
        nameChanged ||
        regionChanged ||
        immutableChanged(news, olds, output)
      ) {
        return {
          action: "replace" as const,
          deleteFirst: !regionChanged,
        };
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
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        targetTcpProxyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetTcpProxies
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetTcpProxies ?? [])
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
      const targetTcpProxyName = yield* toName(
        id,
        news.targetTcpProxyName,
        output?.targetTcpProxyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredService = toBackendServiceRef(
        env.project,
        region,
        news.service,
      );
      const desiredHeader = news.proxyHeader ?? DEFAULT_PROXY_HEADER;
      const desiredBind = news.proxyBind ?? false;
      const desiredScheme = news.loadBalancingScheme ?? "";

      const insertProxy = () => {
        const body: compute.TargetTcpProxy = {
          name: targetTcpProxyName,
          description: desiredDescription,
          service: desiredService,
          proxyHeader: desiredHeader,
        };
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.loadBalancingScheme !== undefined) {
          body.loadBalancingScheme = news.loadBalancingScheme;
        }
        return compute
          .insertRegionTargetTcpProxies({
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
      };

      const deleteProxy = () =>
        compute
          .deleteRegionTargetTcpProxies({
            project: env.project,
            region,
            targetTcpProxy: targetTcpProxyName,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );

      let current = yield* getByName(env.project, region, targetTcpProxyName);

      // Regional target TCP proxies have no setBackendService API. If the
      // observed backend (or other immutable fields) drifted, delete then
      // insert so update-as-well-as-replace converges.
      if (current !== undefined) {
        const serviceChanged =
          resourceTail(current.service) !== resourceTail(desiredService);
        const headerChanged =
          (current.proxyHeader ?? DEFAULT_PROXY_HEADER) !== desiredHeader;
        const descriptionChanged =
          (current.description ?? "") !== desiredDescription;
        const bindChanged = (current.proxyBind === true) !== desiredBind;
        const schemeChanged =
          (current.loadBalancingScheme ?? "") !== desiredScheme;
        if (
          serviceChanged ||
          headerChanged ||
          descriptionChanged ||
          bindChanged ||
          schemeChanged
        ) {
          yield* deleteProxy();
          yield* waitUntilGone(env.project, region, targetTcpProxyName);
          current = undefined;
        }
      }

      if (current === undefined) {
        yield* insertProxy();
        current = yield* getByName(env.project, region, targetTcpProxyName);
      }

      if (current === undefined) {
        return yield* new RegionTargetTcpProxyNotResolved({
          targetTcpProxyName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionTargetTcpProxies({
          project: env.project,
          region,
          targetTcpProxy: output.targetTcpProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      yield* waitUntilGone(env.project, region, output.targetTcpProxyName);
    }),
  });
