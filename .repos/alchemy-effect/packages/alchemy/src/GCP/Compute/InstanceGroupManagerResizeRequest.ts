import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
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

const DEFAULT_ZONE = "us-central1-a";

export type InstanceGroupManagerResizeRequestDuration = compute.Duration;

export type InstanceGroupManagerResizeRequestProps = {
  /**
   * Resize request name (RFC1035, 1-63 chars). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing it
   * replaces the request.
   */
  resizeRequestName?: string;
  /**
   * Zone of the managed instance group (e.g. `us-central1-a`). Immutable.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Managed instance group name or URL. Immutable — changing it replaces
   * the request.
   */
  instanceGroupManager: string;
  /**
   * Number of VMs to create. The group's target size increases by this
   * amount. Immutable.
   */
  resizeBy: number;
  /**
   * Optional description. Resize requests have no labels field — Alchemy
   * ownership is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * How long the created VMs run; they are deleted when it elapses. Compute
   * requires it on insert. Immutable.
   */
  requestedRunDuration: InstanceGroupManagerResizeRequestDuration;
};

export type InstanceGroupManagerResizeRequest = Resource<
  "GCP.Compute.InstanceGroupManagerResizeRequest",
  InstanceGroupManagerResizeRequestProps,
  {
    /** Resize request name. */
    resizeRequestName: string;
    /** Project id. */
    project: string;
    /** Zone short name. */
    zone: string;
    /** Managed instance group name. */
    instanceGroupManager: string;
    /** Number of VMs requested. */
    resizeBy: number | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Requested run duration. */
    requestedRunDuration: InstanceGroupManagerResizeRequestDuration | undefined;
    /** Current state (`ACCEPTED`, `SUCCEEDED`, …). */
    state: string | undefined;
    /** Server-assigned numeric id. */
    resizeRequestId: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal queued resize request on a managed instance group.
 *
 * Resize requests provision additional MIG VMs immediately or by queueing
 * until capacity is available (typically GPU / queued-provisioning
 * machine types). Name, zone, MIG, `resizeBy`, and run duration replace
 * the request — there is no in-place update. Compute has no labels
 * field, so Alchemy stamps ownership into the description.
 *
 * Delete cancels an `ACCEPTED` / `CREATING` request first, then removes
 * the record.
 *
 * ### Creating a Resize Request
 * **Example:** Queue one extra VM
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {});
 * const group = yield* GCP.Compute.InstanceGroupManager("web", {
 *   instanceTemplate: template.templateName,
 *   targetSize: 0,
 * });
 * const request = yield* GCP.Compute.InstanceGroupManagerResizeRequest(
 *   "burst",
 *   {
 *     instanceGroupManager: group.managerName,
 *     zone: group.zone,
 *     resizeBy: 1,
 *     requestedRunDuration: { seconds: "3600" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstanceGroupManagerResizeRequest =
  Resource<InstanceGroupManagerResizeRequest>(
    "GCP.Compute.InstanceGroupManagerResizeRequest",
  );

export class InstanceGroupManagerResizeRequestNotResolved extends Data.TaggedError(
  "GCP.Compute.InstanceGroupManagerResizeRequestNotResolved",
)<{
  resizeRequestName: string;
  instanceGroupManager: string;
  zone: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const zoneOf = (value: string | undefined): string =>
  lastSegment(value) || DEFAULT_ZONE;

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `r${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "resizerequest";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
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

const toAttrs = (
  request: compute.InstanceGroupManagerResizeRequest,
  project: string,
  instanceGroupManager: string,
): InstanceGroupManagerResizeRequest["Attributes"] => {
  const parsed = parseDescription(request.description);
  return {
    resizeRequestName: request.name ?? request.id ?? "",
    project,
    zone: zoneOf(request.zone),
    instanceGroupManager: lastSegment(instanceGroupManager),
    resizeBy: request.resizeBy,
    description: parsed.description,
    requestedRunDuration: request.requestedRunDuration,
    state: request.state,
    resizeRequestId: request.id,
    selfLink: request.selfLink,
    creationTimestamp: request.creationTimestamp,
  };
};

const getByName = (
  project: string,
  zone: string,
  instanceGroupManager: string,
  resizeRequest: string,
) =>
  compute
    .getInstanceGroupManagerResizeRequests({
      project,
      zone,
      instanceGroupManager,
      resizeRequest,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  zone: string,
  instanceGroupManager: string,
  resizeRequestName: string,
) =>
  getByName(project, zone, instanceGroupManager, resizeRequestName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (item) => item !== undefined,
      times: 8,
    }),
  );

const terminalStates = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export const InstanceGroupManagerResizeRequestProvider = () =>
  Provider.succeed(InstanceGroupManagerResizeRequest, {
    stables: [
      "resizeRequestName",
      "project",
      "zone",
      "instanceGroupManager",
      "resizeBy",
      "resizeRequestId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.resizeRequestName ?? output?.resizeRequestName;
      const nextName = news.resizeRequestName;
      const previousZone = zoneOf(olds?.zone ?? output?.zone);
      const nextZone = zoneOf(news.zone ?? output?.zone);
      const previousMig = lastSegment(
        olds?.instanceGroupManager ?? output?.instanceGroupManager,
      );
      const nextMig = lastSegment(news.instanceGroupManager);
      const previousBy = olds?.resizeBy ?? output?.resizeBy;
      const nextBy = news.resizeBy;
      if (
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousZone !== nextZone ||
        previousMig !== nextMig ||
        (previousBy !== undefined && previousBy !== nextBy)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName !== undefined &&
            previousName === nextName &&
            previousZone === nextZone &&
            previousMig === nextMig,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resizeRequestName = yield* toName(
        id,
        olds?.resizeRequestName,
        output?.resizeRequestName,
      );
      const zone = zoneOf(olds?.zone ?? output?.zone);
      const instanceGroupManager = lastSegment(
        olds?.instanceGroupManager ?? output?.instanceGroupManager,
      );
      if (!instanceGroupManager) return undefined;
      const existing = yield* getByName(
        env.project,
        zone,
        instanceGroupManager,
        resizeRequestName,
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
          .pipe(Stream.runCollect);
        const managers = Array.from(pages).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("zones/")) return [];
            const zone = scope.slice("zones/".length);
            return (scoped?.instanceGroupManagers ?? [])
              .filter((manager) => manager.name)
              .map((manager) => ({
                zone,
                name: manager.name ?? "",
              }));
          }),
        );
        const perManager = yield* Effect.forEach(
          managers,
          ({ zone, name }) =>
            compute.listInstanceGroupManagerResizeRequests
              .items({
                project: env.project,
                zone,
                instanceGroupManager: name,
                maxResults: 500,
              })
              .pipe(
                Stream.filter((request) => {
                  const { labels } = parseDescription(request.description);
                  return Object.keys(labels).some((key) =>
                    key.startsWith("alchemy-"),
                  );
                }),
                Stream.map((request) => toAttrs(request, env.project, name)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
          { concurrency: 4 },
        );
        return perManager.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resizeRequestName = yield* toName(
        id,
        news.resizeRequestName,
        output?.resizeRequestName,
      );
      const zone = zoneOf(news.zone ?? output?.zone);
      const instanceGroupManager = lastSegment(news.instanceGroupManager);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);

      let current = yield* getByName(
        env.project,
        zone,
        instanceGroupManager,
        resizeRequestName,
      );

      if (current === undefined) {
        yield* compute
          .insertInstanceGroupManagerResizeRequests({
            project: env.project,
            zone,
            instanceGroupManager,
            body: {
              name: resizeRequestName,
              description,
              resizeBy: news.resizeBy,
              requestedRunDuration: news.requestedRunDuration,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(
          env.project,
          zone,
          instanceGroupManager,
          resizeRequestName,
        );
      }

      if (current === undefined) {
        return yield* new InstanceGroupManagerResizeRequestNotResolved({
          resizeRequestName,
          instanceGroupManager,
          zone,
        });
      }

      return toAttrs(current, env.project, instanceGroupManager);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const zone = zoneOf(output.zone);
      const instanceGroupManager = lastSegment(output.instanceGroupManager);
      const existing = yield* getByName(
        env.project,
        zone,
        instanceGroupManager,
        output.resizeRequestName,
      );
      if (existing === undefined) return;

      if (!terminalStates.has(existing.state ?? "")) {
        const cancelled = yield* compute
          .cancelInstanceGroupManagerResizeRequests({
            project: env.project,
            zone,
            instanceGroupManager,
            resizeRequest: output.resizeRequestName,
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (cancelled !== undefined) {
          yield* waitZoneOperation(env.project, zone, cancelled).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }
        yield* getByName(
          env.project,
          zone,
          instanceGroupManager,
          output.resizeRequestName,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (item) =>
              item === undefined || terminalStates.has(item.state ?? ""),
            times: 10,
          }),
        );
      }

      const operation = yield* compute
        .deleteInstanceGroupManagerResizeRequests({
          project: env.project,
          zone,
          instanceGroupManager,
          resizeRequest: output.resizeRequestName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitZoneOperation(env.project, zone, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
