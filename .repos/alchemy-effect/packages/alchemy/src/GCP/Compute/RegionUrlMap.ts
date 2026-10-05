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

export type RegionUrlMapProps = {
  /**
   * UrlMap name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  urlMapName?: string;
  /**
   * Region the URL map lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the resource. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute RegionUrlMap has
   * no labels field).
   */
  description?: string;
  /**
   * Default regional backend service URL used when no host rule matches.
   * Mutually exclusive with `defaultUrlRedirect` and
   * `defaultRouteAction.weightedBackendServices`.
   */
  defaultService?: string;
  /**
   * Redirect used when no host rule matches. Mutually exclusive with
   * `defaultService`.
   */
  defaultUrlRedirect?: compute.HttpRedirectAction;
  /**
   * Advanced routing used when no host rule matches. Mutually exclusive
   * with `defaultService` / `defaultUrlRedirect` when
   * `weightedBackendServices` is set.
   */
  defaultRouteAction?: compute.HttpRouteAction;
  /**
   * Host-matching rules that select a named path matcher.
   */
  hostRules?: compute.HostRule[];
  /**
   * Named path matchers referenced by `hostRules`.
   */
  pathMatchers?: compute.PathMatcher[];
  /**
   * Optional header transformations applied after path-matcher headers.
   */
  headerAction?: compute.HttpHeaderAction;
  /**
   * UrlMap tests that must pass before an update is accepted (max 100).
   */
  tests?: compute.UrlMapTest[];
};

export type RegionUrlMap = Resource<
  "GCP.Compute.RegionUrlMap",
  RegionUrlMapProps,
  {
    /** UrlMap name. */
    urlMapName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Default regional backend service URL. */
    defaultService: string | undefined;
    /** Default redirect, if configured. */
    defaultUrlRedirect: compute.HttpRedirectAction | undefined;
    /** Default route action, if configured. */
    defaultRouteAction: compute.HttpRouteAction | undefined;
    /** Host-matching rules. */
    hostRules: compute.HostRule[];
    /** Named path matchers. */
    pathMatchers: compute.PathMatcher[];
    /** Header transformations, if configured. */
    headerAction: compute.HttpHeaderAction | undefined;
    /** UrlMap tests. */
    tests: compute.UrlMapTest[];
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    urlMapId: string | undefined;
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
 * A regional Compute Engine URL map.
 *
 * Regional URL maps route hostnames and URL paths to a regional backend
 * service or HTTP redirect. They back internal Application Load Balancers
 * and regional external / internal Application Load Balancers. This
 * resource maps to the `regionUrlMaps` collection (the global `urlMaps`
 * collection is `GCP.Compute.UrlMap`). Compute RegionUrlMap has no labels
 * field — Alchemy ownership is stored in the description so nuke can find
 * leaked maps.
 *
 * One of `defaultService`, `defaultUrlRedirect`, or
 * `defaultRouteAction.weightedBackendServices` is required.
 *
 * ### Creating a Regional URL Map
 * **Example:** Generated name with a default HTTPS redirect
 * ```typescript
 * const map = yield* GCP.Compute.RegionUrlMap("web", {
 *   region: "us-central1",
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * ```
 *
 * **Example:** Host rules and path matchers
 * ```typescript
 * const map = yield* GCP.Compute.RegionUrlMap("web", {
 *   description: "public https",
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     stripQuery: false,
 *   },
 *   hostRules: [{ hosts: ["example.com"], pathMatcher: "all" }],
 *   pathMatchers: [
 *     {
 *       name: "all",
 *       defaultUrlRedirect: {
 *         httpsRedirect: true,
 *         hostRedirect: "www.example.com",
 *         stripQuery: false,
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Default regional backend service
 * ```typescript
 * const map = yield* GCP.Compute.RegionUrlMap("web", {
 *   defaultService: backend.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionUrlMap = Resource<RegionUrlMap>("GCP.Compute.RegionUrlMap");

export class RegionUrlMapNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionUrlMapNotResolved",
)<{
  urlMapName: string;
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
    return /^[a-z]/.test(generated) ? generated : `u${generated}`.slice(0, 63);
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

const toBody = (
  urlMapName: string,
  props: RegionUrlMapProps,
  ownership: Record<string, string>,
  fingerprint?: string,
): compute.UrlMap => ({
  name: urlMapName,
  fingerprint,
  description: encodeDescription(ownership, props.description),
  defaultService: props.defaultService,
  defaultUrlRedirect: props.defaultUrlRedirect,
  defaultRouteAction: props.defaultRouteAction,
  hostRules: props.hostRules,
  pathMatchers: props.pathMatchers,
  headerAction: props.headerAction,
  tests: props.tests,
});

const toAttrs = (urlMap: compute.UrlMap, project: string) => {
  const parsed = parseDescription(urlMap.description);
  return {
    urlMapName: urlMap.name ?? urlMap.id ?? "",
    project,
    region: lastSegment(urlMap.region ?? "").toLowerCase(),
    description: parsed.description,
    defaultService: urlMap.defaultService,
    defaultUrlRedirect: urlMap.defaultUrlRedirect,
    defaultRouteAction: urlMap.defaultRouteAction,
    hostRules: urlMap.hostRules ?? [],
    pathMatchers: urlMap.pathMatchers ?? [],
    headerAction: urlMap.headerAction,
    tests: urlMap.tests ?? [],
    selfLink: urlMap.selfLink,
    urlMapId: urlMap.id,
    fingerprint: urlMap.fingerprint,
    creationTimestamp: urlMap.creationTimestamp,
    kind: urlMap.kind,
  };
};

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0);

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined || desired === null) return isEmpty(observed);
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (typeof desired === "object") {
    if (
      observed === undefined ||
      observed === null ||
      typeof observed !== "object"
    ) {
      return false;
    }
    const current = observed as Record<string, unknown>;
    for (const [key, value] of Object.entries(
      desired as Record<string, unknown>,
    )) {
      if (value === undefined) continue;
      if (!subsetEqual(current[key], value)) return false;
    }
    return true;
  }
  return observed === desired;
};

const needsUpdate = (current: compute.UrlMap, desired: compute.UrlMap) =>
  (current.description ?? "") !== (desired.description ?? "") ||
  !subsetEqual(current.defaultService, desired.defaultService) ||
  !subsetEqual(current.defaultUrlRedirect, desired.defaultUrlRedirect) ||
  !subsetEqual(current.defaultRouteAction, desired.defaultRouteAction) ||
  !subsetEqual(current.hostRules, desired.hostRules) ||
  !subsetEqual(current.pathMatchers, desired.pathMatchers) ||
  !subsetEqual(current.headerAction, desired.headerAction) ||
  !subsetEqual(current.tests, desired.tests);

const getByName = (project: string, region: string, urlMap: string) =>
  compute
    .getRegionUrlMaps({ project, region, urlMap })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RegionUrlMapProvider = () =>
  Provider.succeed(RegionUrlMap, {
    stables: [
      "urlMapName",
      "project",
      "region",
      "urlMapId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.urlMapName ?? output?.urlMapName;
      const nextName = news.urlMapName ?? previousName;
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
      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const urlMapName = yield* toName(
        id,
        olds?.urlMapName,
        output?.urlMapName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, urlMapName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListUrlMaps
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.urlMaps ?? [])
              .filter((urlMap) => (urlMap.region ?? "").length > 0)
              .filter((urlMap) => hasOwnershipMarker(urlMap.description))
              .map((urlMap) => toAttrs(urlMap, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const urlMapName = yield* toName(id, news.urlMapName, output?.urlMapName);
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(urlMapName, news, ownership);

      let current = yield* getByName(env.project, region, urlMapName);

      if (current === undefined) {
        yield* compute
          .insertRegionUrlMaps({
            project: env.project,
            region,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, region, urlMapName);
      }

      if (current === undefined) {
        return yield* new RegionUrlMapNotResolved({ urlMapName, region });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .updateRegionUrlMaps({
            project: env.project,
            region,
            urlMap: urlMapName,
            body: toBody(urlMapName, news, ownership, current.fingerprint),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, urlMapName);
        if (current === undefined) {
          return yield* new RegionUrlMapNotResolved({ urlMapName, region });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionUrlMaps({
          project: env.project,
          region,
          urlMap: output.urlMapName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
