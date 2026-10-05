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

const DEFAULT_AGGREGATION = "NO_AGGREGATION";

export type RegionHealthCheckServiceAggregationPolicy =
  | compute.HealthCheckServiceHealthStatusAggregationPolicyEnum
  | (string & {});

export type RegionHealthCheckServiceProps = {
  /**
   * Service name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the service.
   */
  serviceName?: string;
  /**
   * Region the service lives in. Immutable — changing it replaces the
   * service. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Health check services have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
  /**
   * Regional health-check URLs. Must have at least one and at most 10.
   * Health checks must use `USE_SERVING_PORT` or `USE_FIXED_PORT`.
   */
  healthChecks: string[];
  /**
   * Network endpoint group URLs (at most 100). Regional NEGs must be in
   * zones of this region.
   */
  networkEndpointGroups?: string[];
  /**
   * Notification endpoint URLs (at most 10). Must be regional and in the
   * same region.
   */
  notificationEndpoints?: string[];
  /**
   * How results from multiple health checks for the same endpoint are
   * aggregated (`AND` or `NO_AGGREGATION`).
   * @default "NO_AGGREGATION"
   */
  healthStatusAggregationPolicy?: RegionHealthCheckServiceAggregationPolicy;
};

export type RegionHealthCheckService = Resource<
  "GCP.Compute.RegionHealthCheckService",
  RegionHealthCheckServiceProps,
  {
    /** Service name. */
    serviceName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Attached health-check URLs. */
    healthChecks: string[];
    /** Attached NEG URLs. */
    networkEndpointGroups: string[];
    /** Attached notification endpoint URLs. */
    notificationEndpoints: string[];
    /** Aggregation policy. */
    healthStatusAggregationPolicy: string;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    serviceId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Health Check as a Service (HCSS) resource.
 *
 * Health check services publish endpoint health from NEGs to notification
 * endpoints. Name and region are immutable. Health checks, NEGs,
 * notification endpoints, aggregation policy, and description update in
 * place via `regionHealthCheckServices.patch`.
 *
 * ### Creating a Health Check Service
 * **Example:** Generated name with a regional HTTP health check
 * ```typescript
 * const check = yield* GCP.Compute.RegionHealthCheck("api", {
 *   httpHealthCheck: { port: 80, portSpecification: "USE_FIXED_PORT" },
 * });
 * const service = yield* GCP.Compute.RegionHealthCheckService("Hcss", {
 *   healthChecks: [check.selfLink],
 *   description: "endpoint health",
 * });
 * ```
 *
 * **Example:** AND aggregation
 * ```typescript
 * const service = yield* GCP.Compute.RegionHealthCheckService("Hcss", {
 *   healthChecks: [check.selfLink],
 *   healthStatusAggregationPolicy: "AND",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionHealthCheckService = Resource<RegionHealthCheckService>(
  "GCP.Compute.RegionHealthCheckService",
);

export class RegionHealthCheckServiceNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionHealthCheckServiceNotResolved",
)<{
  serviceName: string;
  region: string;
}> {}

const aggregationOf = (value: string | undefined) =>
  (value ?? DEFAULT_AGGREGATION).toUpperCase();

const toAttrs = (
  service: compute.HealthCheckService,
  project: string,
): RegionHealthCheckService["Attributes"] => {
  const parsed = parseDescription(service.description);
  return {
    serviceName: service.name ?? lastSegment(service.selfLink),
    project,
    region: lastSegment(service.region).toLowerCase(),
    description: parsed.description,
    healthChecks: service.healthChecks ?? [],
    networkEndpointGroups: service.networkEndpointGroups ?? [],
    notificationEndpoints: service.notificationEndpoints ?? [],
    healthStatusAggregationPolicy: aggregationOf(
      service.healthStatusAggregationPolicy,
    ),
    fingerprint: service.fingerprint,
    selfLink: service.selfLink,
    serviceId: service.id,
    creationTimestamp: service.creationTimestamp,
    kind: service.kind,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionHealthCheckServices({
      project,
      region,
      healthCheckService: name,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, serviceName: string) =>
  getByName(project, region, serviceName).pipe(
    Effect.flatMap((service) =>
      service !== undefined
        ? Effect.succeed(service)
        : Effect.fail(
            new RegionHealthCheckServiceNotResolved({ serviceName, region }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionHealthCheckServiceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RegionHealthCheckServiceProvider = () =>
  Provider.succeed(RegionHealthCheckService, {
    stables: [
      "serviceName",
      "project",
      "region",
      "serviceId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.serviceName ?? output?.serviceName;
      const nextName = news.serviceName ?? previousName;
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
      if (nameChanged || regionChanged) {
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
      const serviceName = yield* toPhysicalName(
        id,
        olds?.serviceName,
        output?.serviceName,
        "service",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, serviceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListRegionHealthCheckServices
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
          pages as readonly compute.HealthCheckServiceAggregatedList[],
        ).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.resources ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceName = yield* toPhysicalName(
        id,
        news.serviceName,
        output?.serviceName,
        "service",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const aggregation = aggregationOf(news.healthStatusAggregationPolicy);
      const healthChecks = news.healthChecks;
      const networkEndpointGroups = news.networkEndpointGroups ?? [];
      const notificationEndpoints = news.notificationEndpoints ?? [];

      let current = yield* getByName(env.project, region, serviceName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionHealthCheckServices({
            project: env.project,
            region,
            body: {
              name: serviceName,
              description: desiredDescription,
              healthChecks,
              networkEndpointGroups:
                networkEndpointGroups.length > 0
                  ? networkEndpointGroups
                  : undefined,
              notificationEndpoints:
                notificationEndpoints.length > 0
                  ? notificationEndpoints
                  : undefined,
              healthStatusAggregationPolicy: aggregation,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, serviceName);
      }

      if (current === undefined) {
        return yield* new RegionHealthCheckServiceNotResolved({
          serviceName,
          region,
        });
      }

      const patch: compute.HealthCheckService = {
        fingerprint: current.fingerprint,
      };
      let dirty = false;
      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
        dirty = true;
      }
      if (!sameUrlList(current.healthChecks, healthChecks)) {
        patch.healthChecks = healthChecks;
        dirty = true;
      }
      if (
        news.networkEndpointGroups !== undefined &&
        !sameUrlList(current.networkEndpointGroups, networkEndpointGroups)
      ) {
        patch.networkEndpointGroups = networkEndpointGroups;
        dirty = true;
      }
      if (
        news.notificationEndpoints !== undefined &&
        !sameUrlList(current.notificationEndpoints, notificationEndpoints)
      ) {
        patch.notificationEndpoints = notificationEndpoints;
        dirty = true;
      }
      if (
        aggregationOf(current.healthStatusAggregationPolicy) !== aggregation
      ) {
        patch.healthStatusAggregationPolicy = aggregation;
        dirty = true;
      }
      if (dirty) {
        yield* runRegionOp(
          env.project,
          region,
          compute.patchRegionHealthCheckServices({
            project: env.project,
            region,
            healthCheckService: serviceName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, region, serviceName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionHealthCheckServices({
          project: env.project,
          region,
          healthCheckService: output.serviceName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
