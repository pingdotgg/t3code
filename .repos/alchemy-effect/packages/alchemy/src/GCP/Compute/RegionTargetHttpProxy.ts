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

export type RegionTargetHttpProxyProps = {
  /**
   * TargetHttpProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetHttpProxyName?: string;
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
   * RegionTargetHttpProxy has no labels field and no patch API, so
   * changing the description replaces the proxy).
   */
  description?: string;
  /**
   * Regional URL map this proxy routes to. Accepts a RegionUrlMap
   * self-link, a `projects/{project}/regions/{region}/urlMaps/{name}`
   * path, or the UrlMap name.
   */
  urlMap: string;
  /**
   * Bind inbound traffic to the forwarding-rule address. Only applies when
   * the referencing forwarding rule uses `INTERNAL_SELF_MANAGED`.
   * Immutable — changing it replaces the proxy.
   * @default false
   */
  proxyBind?: boolean;
  /**
   * Idle keep-alive timeout in seconds after a response completes with no
   * matching traffic. Regional Application Load Balancers allow 5–600
   * (default 610). Immutable — changing it replaces the proxy.
   */
  httpKeepAliveTimeoutSec?: number;
};

export type RegionTargetHttpProxy = Resource<
  "GCP.Compute.RegionTargetHttpProxy",
  RegionTargetHttpProxyProps,
  {
    /** TargetHttpProxy name. */
    targetHttpProxyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached regional UrlMap. */
    urlMap: string;
    /** Whether Envoy inbound bind is enabled. */
    proxyBind: boolean;
    /** HTTP keep-alive timeout in seconds, if set. */
    httpKeepAliveTimeoutSec: number | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetHttpProxyId: string | undefined;
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
 * A regional Compute Engine target HTTP proxy.
 *
 * Regional target HTTP proxies are referenced by regional forwarding rules
 * and point at a regional URL map that routes host/path to a backend
 * service or redirect. This resource maps to the `regionTargetHttpProxies`
 * collection (`targetHttpProxies` is `GCP.Compute.TargetHttpProxy`).
 * Compute RegionTargetHttpProxy has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked proxies. The only
 * in-place mutation is `setUrlMap`; name, region, description,
 * `proxyBind`, and `httpKeepAliveTimeoutSec` replace the proxy.
 *
 * ### Creating a Regional Target HTTP Proxy
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
 * const proxy = yield* GCP.Compute.RegionTargetHttpProxy("http", {
 *   region: "us-central1",
 *   urlMap: map.urlMapName,
 * });
 * ```
 *
 * **Example:** Explicit name and description
 * ```typescript
 * const proxy = yield* GCP.Compute.RegionTargetHttpProxy("http", {
 *   targetHttpProxyName: "app-http",
 *   region: "us-central1",
 *   description: "public http frontend",
 *   urlMap: map.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionTargetHttpProxy = Resource<RegionTargetHttpProxy>(
  "GCP.Compute.RegionTargetHttpProxy",
);

export class RegionTargetHttpProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionTargetHttpProxyNotResolved",
)<{
  targetHttpProxyName: string;
  region: string;
}> {}

const lastSegment = (value: string) => {
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
    return /^[a-z]/.test(generated) ? generated : `p${generated}`.slice(0, 63);
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

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  return lastSegment(value);
};

const toUrlMapRef = (
  project: string,
  region: string,
  urlMap: string,
): string => {
  if (urlMap.includes("/")) return urlMap;
  return `projects/${project}/regions/${region}/urlMaps/${urlMap}`;
};

const toAttrs = (proxy: compute.TargetHttpProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetHttpProxyName: proxy.name ?? proxy.id ?? "",
    project,
    region: lastSegment(proxy.region ?? "").toLowerCase(),
    description: parsed.description,
    urlMap: proxy.urlMap ?? "",
    proxyBind: proxy.proxyBind === true,
    httpKeepAliveTimeoutSec: proxy.httpKeepAliveTimeoutSec,
    selfLink: proxy.selfLink,
    targetHttpProxyId: proxy.id,
    fingerprint: proxy.fingerprint,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, region: string, targetHttpProxy: string) =>
  compute
    .getRegionTargetHttpProxies({ project, region, targetHttpProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const immutableChanged = (
  news: RegionTargetHttpProxyProps,
  olds: RegionTargetHttpProxyProps | undefined,
  output: RegionTargetHttpProxy["Attributes"] | undefined,
) => {
  const previousDescription = olds?.description ?? output?.description;
  if (
    news.description !== undefined &&
    news.description !== previousDescription
  ) {
    return true;
  }
  const previousBind = olds?.proxyBind ?? output?.proxyBind;
  if (news.proxyBind !== undefined && news.proxyBind !== previousBind) {
    return true;
  }
  const previousKeepAlive =
    olds?.httpKeepAliveTimeoutSec ?? output?.httpKeepAliveTimeoutSec;
  if (
    news.httpKeepAliveTimeoutSec !== undefined &&
    news.httpKeepAliveTimeoutSec !== previousKeepAlive
  ) {
    return true;
  }
  return false;
};

export const RegionTargetHttpProxyProvider = () =>
  Provider.succeed(RegionTargetHttpProxy, {
    stables: [
      "targetHttpProxyName",
      "project",
      "region",
      "targetHttpProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.targetHttpProxyName ?? output?.targetHttpProxyName;
      const nextName = news.targetHttpProxyName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;
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
      const targetHttpProxyName = yield* toName(
        id,
        olds?.targetHttpProxyName,
        output?.targetHttpProxyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        targetHttpProxyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetHttpProxies
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetHttpProxies ?? [])
              .filter((proxy) => (proxy.region ?? "").length > 0)
              .filter((proxy) => hasOwnershipMarker(proxy.description))
              .map((proxy) => toAttrs(proxy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetHttpProxyName = yield* toName(
        id,
        news.targetHttpProxyName,
        output?.targetHttpProxyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredUrlMap = toUrlMapRef(env.project, region, news.urlMap);

      let current = yield* getByName(env.project, region, targetHttpProxyName);

      if (current === undefined) {
        const body: compute.TargetHttpProxy = {
          name: targetHttpProxyName,
          description: desiredDescription,
          urlMap: desiredUrlMap,
        };
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        yield* compute
          .insertRegionTargetHttpProxies({
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
        current = yield* getByName(env.project, region, targetHttpProxyName);
      }

      if (current === undefined) {
        return yield* new RegionTargetHttpProxyNotResolved({
          targetHttpProxyName,
          region,
        });
      }

      if (resourceTail(current.urlMap) !== resourceTail(desiredUrlMap)) {
        yield* compute
          .setUrlMapRegionTargetHttpProxies({
            project: env.project,
            region,
            targetHttpProxy: targetHttpProxyName,
            body: { urlMap: desiredUrlMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, targetHttpProxyName);
        if (current === undefined) {
          return yield* new RegionTargetHttpProxyNotResolved({
            targetHttpProxyName,
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
        .deleteRegionTargetHttpProxies({
          project: env.project,
          region,
          targetHttpProxy: output.targetHttpProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
