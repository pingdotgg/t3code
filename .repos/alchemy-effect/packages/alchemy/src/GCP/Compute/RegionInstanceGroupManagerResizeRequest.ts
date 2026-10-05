import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  normalizeRegion,
  parseDescription,
  runRegionOp,
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

export type RegionInstanceGroupManagerResizeRequestDuration = {
  /** Whole seconds. */
  seconds?: string;
  /** Fractional seconds at nanosecond resolution. */
  nanos?: number;
};

export type RegionInstanceGroupManagerResizeRequestProps = {
  /**
   * Resize-request name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the request.
   */
  requestName?: string;
  /**
   * Region of the parent managed instance group. Immutable. `US-CENTRAL1`
   * is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Parent regional managed instance group name or URL. Immutable —
   * changing it replaces the request.
   */
  instanceGroupManager: string;
  /**
   * Number of instances to create. The group's target size increases by
   * this number. Immutable — changing it replaces the request.
   */
  resizeBy: number;
  /**
   * Optional description. Resize requests have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
  /**
   * Requested run duration for VMs created by this request. At the end of
   * the duration the instance is deleted. Compute requires it on insert.
   * Immutable.
   */
  requestedRunDuration: RegionInstanceGroupManagerResizeRequestDuration;
};

export type RegionInstanceGroupManagerResizeRequest = Resource<
  "GCP.Compute.RegionInstanceGroupManagerResizeRequest",
  RegionInstanceGroupManagerResizeRequestProps,
  {
    /** Resize-request name. */
    requestName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent managed instance group name. */
    instanceGroupManager: string;
    /** Requested instance count delta. */
    resizeBy: number;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Requested run duration, if set. */
    requestedRunDuration:
      | RegionInstanceGroupManagerResizeRequestDuration
      | undefined;
    /** Current request state. */
    state: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** Server-assigned numeric id. */
    requestId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional managed instance group resize request.
 *
 * Resize requests provision (or queue) additional VMs on a regional MIG.
 * They are immutable after create — changing `resizeBy`, duration, the
 * parent group, or the name replaces the request. Delete cancels an
 * in-flight request first when the API requires it.
 *
 * ### Creating a Resize Request
 * **Example:** Queue one extra VM
 * ```typescript
 * const request = yield* GCP.Compute.RegionInstanceGroupManagerResizeRequest(
 *   "Burst",
 *   {
 *     instanceGroupManager: manager.managerName,
 *     resizeBy: 1,
 *     requestedRunDuration: { seconds: "3600" },
 *     description: "burst capacity",
 *   },
 * );
 * ```
 *
 * **Example:** Timed run
 * ```typescript
 * const request = yield* GCP.Compute.RegionInstanceGroupManagerResizeRequest(
 *   "Burst",
 *   {
 *     instanceGroupManager: manager.managerName,
 *     resizeBy: 1,
 *     requestedRunDuration: { seconds: "3600" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionInstanceGroupManagerResizeRequest =
  Resource<RegionInstanceGroupManagerResizeRequest>(
    "GCP.Compute.RegionInstanceGroupManagerResizeRequest",
  );

export class RegionInstanceGroupManagerResizeRequestNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionInstanceGroupManagerResizeRequestNotResolved",
)<{
  requestName: string;
  instanceGroupManager: string;
  region: string;
}> {}

const managerNameOf = (value: string) => lastSegment(value);

const toAttrs = (
  request: compute.InstanceGroupManagerResizeRequest,
  project: string,
  instanceGroupManager: string,
): RegionInstanceGroupManagerResizeRequest["Attributes"] => {
  const parsed = parseDescription(request.description);
  return {
    requestName: request.name ?? lastSegment(request.selfLink),
    project,
    region: lastSegment(request.region).toLowerCase(),
    instanceGroupManager: managerNameOf(instanceGroupManager),
    resizeBy: request.resizeBy ?? 0,
    description: parsed.description,
    requestedRunDuration: request.requestedRunDuration,
    state: request.state,
    selfLink: request.selfLink,
    selfLinkWithId: request.selfLinkWithId,
    requestId: request.id,
    creationTimestamp: request.creationTimestamp,
    kind: request.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  instanceGroupManager: string,
  resizeRequest: string,
) =>
  compute
    .getRegionInstanceGroupManagerResizeRequests({
      project,
      region,
      instanceGroupManager,
      resizeRequest,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  instanceGroupManager: string,
  requestName: string,
) =>
  getByName(project, region, instanceGroupManager, requestName).pipe(
    Effect.flatMap((request) =>
      request !== undefined
        ? Effect.succeed(request)
        : Effect.fail(
            new RegionInstanceGroupManagerResizeRequestNotResolved({
              requestName,
              instanceGroupManager,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Compute.RegionInstanceGroupManagerResizeRequestNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const needsCancel = (state: string | undefined) => {
  const current = (state ?? "").toUpperCase();
  return current === "ACCEPTED" || current === "CREATING";
};

export const RegionInstanceGroupManagerResizeRequestProvider = () =>
  Provider.succeed(RegionInstanceGroupManagerResizeRequest, {
    stables: [
      "requestName",
      "project",
      "region",
      "instanceGroupManager",
      "requestId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.requestName ?? output?.requestName;
      const nextName = news.requestName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      const previousManager = managerNameOf(
        olds?.instanceGroupManager ?? output?.instanceGroupManager ?? "",
      );
      const nextManager = managerNameOf(news.instanceGroupManager);
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const managerChanged =
        previousManager.length > 0 && previousManager !== nextManager;
      const resizeChanged =
        (olds?.resizeBy ?? output?.resizeBy) !== undefined &&
        news.resizeBy !== (olds?.resizeBy ?? output?.resizeBy);
      if (nameChanged || regionChanged || managerChanged || resizeChanged) {
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
      const requestName = yield* toPhysicalName(
        id,
        olds?.requestName,
        output?.requestName,
        "resize",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const instanceGroupManager = managerNameOf(
        olds?.instanceGroupManager ?? output?.instanceGroupManager ?? "",
      );
      if (instanceGroupManager.length === 0) return undefined;
      const existing = yield* getByName(
        env.project,
        region,
        instanceGroupManager,
        requestName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, instanceGroupManager);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstanceGroupManagers
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
          );
        const managers = Array.from(
          pages as readonly compute.InstanceGroupManagerAggregatedList[],
        ).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("regions/")) return [];
            return (scoped?.instanceGroupManagers ?? [])
              .filter((manager) => lastSegment(manager.region).length > 0)
              .map((manager) => ({
                name: manager.name ?? lastSegment(manager.selfLink),
                region: lastSegment(manager.region).toLowerCase(),
              }));
          }),
        );
        const listed: RegionInstanceGroupManagerResizeRequest["Attributes"][] =
          [];
        for (const manager of managers) {
          const chunk =
            yield* compute.listRegionInstanceGroupManagerResizeRequests
              .items({
                project: env.project,
                region: manager.region,
                instanceGroupManager: manager.name,
                maxResults: 500,
                returnPartialSuccess: true,
              })
              .pipe(
                Stream.filter((item) => hasOwnershipMarker(item.description)),
                Stream.map((item) => toAttrs(item, env.project, manager.name)),
                Stream.runCollect,
                Effect.map((items) => Array.from(items)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed(
                    [] as RegionInstanceGroupManagerResizeRequest["Attributes"][],
                  ),
                ),
              );
          listed.push(...chunk);
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const requestName = yield* toPhysicalName(
        id,
        news.requestName,
        output?.requestName,
        "resize",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const instanceGroupManager = managerNameOf(news.instanceGroupManager);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(
        env.project,
        region,
        instanceGroupManager,
        requestName,
      );

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionInstanceGroupManagerResizeRequests({
            project: env.project,
            region,
            instanceGroupManager,
            body: {
              name: requestName,
              description: desiredDescription,
              resizeBy: news.resizeBy,
              requestedRunDuration: news.requestedRunDuration,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(
          env.project,
          region,
          instanceGroupManager,
          requestName,
        );
      }

      if (current === undefined) {
        return yield* new RegionInstanceGroupManagerResizeRequestNotResolved({
          requestName,
          instanceGroupManager,
          region,
        });
      }

      return toAttrs(current, env.project, instanceGroupManager);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const instanceGroupManager = managerNameOf(output.instanceGroupManager);
      const current = yield* getByName(
        env.project,
        region,
        instanceGroupManager,
        output.requestName,
      );
      if (current !== undefined && needsCancel(current.state)) {
        yield* runRegionOp(
          env.project,
          region,
          compute.cancelRegionInstanceGroupManagerResizeRequests({
            project: env.project,
            region,
            instanceGroupManager,
            resizeRequest: output.requestName,
          }),
          { ignoreNotFound: true },
        ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      }
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionInstanceGroupManagerResizeRequests({
          project: env.project,
          region,
          instanceGroupManager,
          resizeRequest: output.requestName,
        }),
        { ignoreNotFound: true },
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
  });
