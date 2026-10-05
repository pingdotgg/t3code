import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  normalizeRegion,
  parseDescription,
  runRegionOp,
  sameUrlList,
  toPhysicalName,
} from "./internal.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_SOURCE_TYPE = "BACKEND_SERVICE";

export type RegionHealthSourceType =
  | compute.HealthSourceSourceTypeEnum
  | (string & {});

export type RegionHealthSourceProps = {
  /**
   * Source name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the source.
   */
  sourceName?: string;
  /**
   * Region the source lives in. Immutable — changing it replaces the
   * source. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Health sources have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Source type. The only allowed value is `BACKEND_SERVICE`. Immutable —
   * changing it replaces the source.
   * @default "BACKEND_SERVICE"
   */
  sourceType?: RegionHealthSourceType;
  /**
   * URLs to the source resources. Must be size 1. Must be a regional
   * BackendService with load balancing scheme `INTERNAL` or
   * `INTERNAL_MANAGED` in the same region.
   */
  sources: string[];
  /**
   * URL of the regional HealthAggregationPolicy in the same region.
   */
  healthAggregationPolicy: string;
};

export type RegionHealthSource = Resource<
  "GCP.Compute.RegionHealthSource",
  RegionHealthSourceProps,
  {
    /** Source name. */
    sourceName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Source type. */
    sourceType: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Source resource URLs. */
    sources: string[];
    /** Health aggregation policy URL. */
    healthAggregationPolicy: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** Server-assigned numeric id. */
    sourceId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine health source.
 *
 * A health source names the backend resources whose health is aggregated
 * by a HealthAggregationPolicy (used by composite health checks). Type is
 * immutable. Sources, aggregation policy, and description update in place
 * via `regionHealthSources.patch`.
 *
 * ### Creating a Health Source
 * **Example:** Backend-service source
 * ```typescript
 * const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
 *   "Agg",
 *   {},
 * );
 * const backend = yield* GCP.Compute.RegionBackendService("Web", {
 *   protocol: "TCP",
 *   loadBalancingScheme: "INTERNAL",
 * });
 * const source = yield* GCP.Compute.RegionHealthSource("Src", {
 *   sources: [backend.selfLink],
 *   healthAggregationPolicy: policy.selfLink,
 * });
 * ```
 *
 * **Example:** Named source
 * ```typescript
 * const source = yield* GCP.Compute.RegionHealthSource("Src", {
 *   sourceName: "web-health",
 *   sources: [backend.selfLink],
 *   healthAggregationPolicy: policy.selfLink,
 *   description: "internal backends",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionHealthSource = Resource<RegionHealthSource>(
  "GCP.Compute.RegionHealthSource",
);

export class RegionHealthSourceNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionHealthSourceNotResolved",
)<{
  sourceName: string;
  region: string;
}> {}

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_SOURCE_TYPE).toUpperCase();

const toBackendServiceUrl = (
  project: string,
  region: string,
  value: string | undefined,
) => {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes("/backendServices/")) return value;
  return `projects/${project}/regions/${region}/backendServices/${lastSegment(value)}`;
};

const toHealthAggregationPolicyUrl = (
  project: string,
  region: string,
  value: string | undefined,
) => {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes("/healthAggregationPolicies/")) return value;
  return `projects/${project}/regions/${region}/healthAggregationPolicies/${lastSegment(value)}`;
};

const toAttrs = (
  source: compute.HealthSource,
  project: string,
): RegionHealthSource["Attributes"] => {
  const parsed = parseDescription(source.description);
  return {
    sourceName: source.name ?? lastSegment(source.selfLink),
    project,
    region: lastSegment(source.region).toLowerCase(),
    sourceType: typeOf(source.sourceType),
    description: parsed.description,
    sources: source.sources ?? [],
    healthAggregationPolicy: source.healthAggregationPolicy,
    fingerprint: source.fingerprint,
    selfLink: source.selfLink,
    selfLinkWithId: source.selfLinkWithId,
    sourceId: source.id,
    creationTimestamp: source.creationTimestamp,
    kind: source.kind,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionHealthSources({ project, region, healthSource: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, sourceName: string) =>
  getByName(project, region, sourceName).pipe(
    Effect.flatMap((source) =>
      source !== undefined
        ? Effect.succeed(source)
        : Effect.fail(
            new RegionHealthSourceNotResolved({ sourceName, region }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionHealthSourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RegionHealthSourceProvider = () =>
  Provider.succeed(RegionHealthSource, {
    stables: [
      "sourceName",
      "project",
      "region",
      "sourceType",
      "sourceId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.sourceName ?? output?.sourceName;
      const nextName = news.sourceName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const previousType = typeOf(olds?.sourceType ?? output?.sourceType);
      const nextType = typeOf(news.sourceType ?? output?.sourceType);
      if (nameChanged || regionChanged || previousType !== nextType) {
        return {
          action: "replace" as const,
          deleteFirst:
            !nameChanged || nextName === undefined || nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sourceName = yield* toPhysicalName(
        id,
        olds?.sourceName,
        output?.sourceName,
        "source",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, sourceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListRegionHealthSources
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
          );
        return Array.from(
          pages as readonly compute.HealthSourceAggregatedList[],
        ).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.healthSources ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sourceName = yield* toPhysicalName(
        id,
        news.sourceName,
        output?.sourceName,
        "source",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const sourceType = typeOf(news.sourceType);
      const sources = news.sources.flatMap((source) => {
        const url = toBackendServiceUrl(env.project, region, source);
        return url === undefined ? [] : [url];
      });
      const healthAggregationPolicy =
        toHealthAggregationPolicyUrl(
          env.project,
          region,
          news.healthAggregationPolicy,
        ) ?? news.healthAggregationPolicy;

      let current = yield* getByName(env.project, region, sourceName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionHealthSources({
            project: env.project,
            region,
            body: {
              name: sourceName,
              description: desiredDescription,
              sourceType,
              sources,
              healthAggregationPolicy,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, sourceName);
      }

      if (current === undefined) {
        return yield* new RegionHealthSourceNotResolved({
          sourceName,
          region,
        });
      }

      const patch: compute.HealthSource = {
        fingerprint: current.fingerprint,
      };
      let dirty = false;
      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
        dirty = true;
      }
      if (!sameUrlList(current.sources, sources)) {
        patch.sources = sources;
        dirty = true;
      }
      if (
        lastSegment(current.healthAggregationPolicy) !==
        lastSegment(healthAggregationPolicy)
      ) {
        patch.healthAggregationPolicy = healthAggregationPolicy;
        dirty = true;
      }
      if (dirty) {
        yield* runRegionOp(
          env.project,
          region,
          compute.patchRegionHealthSources({
            project: env.project,
            region,
            healthSource: sourceName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, region, sourceName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionHealthSources({
          project: env.project,
          region,
          healthSource: output.sourceName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
