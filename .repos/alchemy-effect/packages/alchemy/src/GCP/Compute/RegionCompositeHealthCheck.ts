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

export type RegionCompositeHealthCheckProps = {
  /**
   * Health check name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  healthCheckName?: string;
  /**
   * Region the composite health check lives in. Immutable — changing it
   * replaces the resource. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Composite health checks have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
  /**
   * URL of the destination ForwardingRule. Must be regional, in the same
   * region, and use load balancing scheme `INTERNAL` or
   * `INTERNAL_MANAGED`.
   */
  healthDestination: string;
  /**
   * URLs of HealthSource resources whose results are AND'ed. Must have at
   * least 1 and at most 10. Must be regional and in the same region.
   */
  healthSources: string[];
};

export type RegionCompositeHealthCheck = Resource<
  "GCP.Compute.RegionCompositeHealthCheck",
  RegionCompositeHealthCheckProps,
  {
    /** Health check name. */
    healthCheckName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Destination forwarding-rule URL. */
    healthDestination: string | undefined;
    /** Health source URLs. */
    healthSources: string[];
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** Server-assigned numeric id. */
    healthCheckId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine composite health check.
 *
 * Composite health checks AND the results of one or more HealthSource
 * resources and publish the aggregate to a destination ForwardingRule.
 * Name and region are immutable. Destination, sources, and description
 * update in place via `regionCompositeHealthChecks.patch`.
 *
 * ### Creating a Composite Health Check
 * **Example:** Generated name
 * ```typescript
 * const check = yield* GCP.Compute.RegionCompositeHealthCheck("Comp", {
 *   healthDestination: rule.selfLink,
 *   healthSources: [source.selfLink],
 *   description: "and backends",
 * });
 * ```
 *
 * **Example:** Named check
 * ```typescript
 * const check = yield* GCP.Compute.RegionCompositeHealthCheck("Comp", {
 *   healthCheckName: "app-composite",
 *   region: "us-central1",
 *   healthDestination: rule.selfLink,
 *   healthSources: [source.selfLink],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionCompositeHealthCheck = Resource<RegionCompositeHealthCheck>(
  "GCP.Compute.RegionCompositeHealthCheck",
);

export class RegionCompositeHealthCheckNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionCompositeHealthCheckNotResolved",
)<{
  healthCheckName: string;
  region: string;
}> {}

const toAttrs = (
  check: compute.CompositeHealthCheck,
  project: string,
): RegionCompositeHealthCheck["Attributes"] => {
  const parsed = parseDescription(check.description);
  return {
    healthCheckName: check.name ?? lastSegment(check.selfLink),
    project,
    region: lastSegment(check.region).toLowerCase(),
    description: parsed.description,
    healthDestination: check.healthDestination,
    healthSources: check.healthSources ?? [],
    fingerprint: check.fingerprint,
    selfLink: check.selfLink,
    selfLinkWithId: check.selfLinkWithId,
    healthCheckId: check.id,
    creationTimestamp: check.creationTimestamp,
    kind: check.kind,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionCompositeHealthChecks({
      project,
      region,
      compositeHealthCheck: name,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  healthCheckName: string,
) =>
  getByName(project, region, healthCheckName).pipe(
    Effect.flatMap((check) =>
      check !== undefined
        ? Effect.succeed(check)
        : Effect.fail(
            new RegionCompositeHealthCheckNotResolved({
              healthCheckName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionCompositeHealthCheckNotResolved",
      times: 20,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const RegionCompositeHealthCheckProvider = () =>
  Provider.succeed(RegionCompositeHealthCheck, {
    stables: [
      "healthCheckName",
      "project",
      "region",
      "healthCheckId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.healthCheckName ?? output?.healthCheckName;
      const nextName = news.healthCheckName ?? previousName;
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
      const healthCheckName = yield* toPhysicalName(
        id,
        olds?.healthCheckName,
        output?.healthCheckName,
        "healthcheck",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, healthCheckName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListRegionCompositeHealthChecks
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
          pages as readonly compute.CompositeHealthCheckAggregatedList[],
        ).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.compositeHealthChecks ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const healthCheckName = yield* toPhysicalName(
        id,
        news.healthCheckName,
        output?.healthCheckName,
        "healthcheck",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, region, healthCheckName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionCompositeHealthChecks({
            project: env.project,
            region,
            body: {
              name: healthCheckName,
              description: desiredDescription,
              healthDestination: news.healthDestination,
              healthSources: news.healthSources,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, healthCheckName);
      }

      if (current === undefined) {
        return yield* new RegionCompositeHealthCheckNotResolved({
          healthCheckName,
          region,
        });
      }

      const patch: compute.CompositeHealthCheck = {
        fingerprint: current.fingerprint,
      };
      let dirty = false;
      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
        dirty = true;
      }
      if (
        lastSegment(current.healthDestination) !==
        lastSegment(news.healthDestination)
      ) {
        patch.healthDestination = news.healthDestination;
        dirty = true;
      }
      if (!sameUrlList(current.healthSources, news.healthSources)) {
        patch.healthSources = news.healthSources;
        dirty = true;
      }
      if (dirty) {
        yield* runRegionOp(
          env.project,
          region,
          compute.patchRegionCompositeHealthChecks({
            project: env.project,
            region,
            compositeHealthCheck: healthCheckName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, region, healthCheckName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionCompositeHealthChecks({
          project: env.project,
          region,
          compositeHealthCheck: output.healthCheckName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
