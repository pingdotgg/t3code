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
const LIST_ZONES = [
  "us-central1-a",
  "us-central1-b",
  "us-central1-c",
  "us-central1-f",
];

export type InstantSnapshotGroupProps = {
  /**
   * Instant snapshot group name (RFC1035, 1-63 chars). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Changing it replaces the group.
   */
  instantSnapshotGroupName?: string;
  /**
   * Zone of the group (e.g. `us-central1-a`). Immutable — changing it
   * replaces the group. Inferred from `sourceConsistencyGroup` when
   * omitted.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Disk consistency-group resource policy URL or name. Immutable —
   * changing it replaces the group.
   */
  sourceConsistencyGroup: string;
  /**
   * Optional description. Instant snapshot groups have no labels field —
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
};

export type InstantSnapshotGroup = Resource<
  "GCP.Compute.InstantSnapshotGroup",
  InstantSnapshotGroupProps,
  {
    /** Instant snapshot group name. */
    instantSnapshotGroupName: string;
    /** Project id. */
    project: string;
    /** Zone short name. */
    zone: string;
    /** Source consistency-group policy URL. */
    sourceConsistencyGroup: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported status. */
    status: string | undefined;
    /** Server-assigned numeric id. */
    instantSnapshotGroupId: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine instant snapshot group.
 *
 * Captures a point-in-time state of every disk in a consistency group.
 * Name, zone, and source policy replace the group. Compute has no labels
 * field, so Alchemy stamps ownership into the description.
 *
 * ### Creating an Instant Snapshot Group
 * **Example:** Snapshot a consistency group
 * ```typescript
 * const policy = yield* GCP.Compute.ResourcePolicy("consistent", {
 *   diskConsistencyGroupPolicy: {},
 * });
 * const group = yield* GCP.Compute.InstantSnapshotGroup("checkpoint", {
 *   zone: "us-central1-a",
 *   sourceConsistencyGroup: policy.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstantSnapshotGroup = Resource<InstantSnapshotGroup>(
  "GCP.Compute.InstantSnapshotGroup",
);

export class InstantSnapshotGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotGroupNotResolved",
)<{
  instantSnapshotGroupName: string;
  zone: string;
}> {}

export class InstantSnapshotGroupNotReady extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotGroupNotReady",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

export class InstantSnapshotGroupFailed extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotGroupFailed",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

export class InstantSnapshotGroupStillExists extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotGroupStillExists",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const zoneOf = (value: string | undefined): string =>
  lastSegment(value) ?? DEFAULT_ZONE;

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `g${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "instantsnapshotgroup";
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
  group: compute.InstantSnapshotGroup,
  project: string,
): InstantSnapshotGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    instantSnapshotGroupName: group.name ?? group.id ?? "",
    project,
    zone: zoneOf(group.zone),
    sourceConsistencyGroup: group.sourceConsistencyGroup,
    description: parsed.description,
    status: group.status,
    instantSnapshotGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
  };
};

const getByName = (
  project: string,
  zone: string,
  instantSnapshotGroup: string,
) =>
  compute
    .getInstantSnapshotGroups({ project, zone, instantSnapshotGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitReady = (
  project: string,
  zone: string,
  instantSnapshotGroupName: string,
) =>
  getByName(project, zone, instantSnapshotGroupName).pipe(
    Effect.flatMap((group) =>
      group?.status === "FAILED" || group?.status === "INVALID"
        ? Effect.fail(
            new InstantSnapshotGroupFailed({
              instantSnapshotGroupName,
              status: group.status ?? "FAILED",
            }),
          )
        : Effect.succeed(group),
    ),
    Effect.filterOrFail(
      (group): group is compute.InstantSnapshotGroup =>
        group !== undefined && group.status === "READY",
      (group) =>
        new InstantSnapshotGroupNotReady({
          instantSnapshotGroupName,
          status: group?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstantSnapshotGroupNotReady",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitGone = (
  project: string,
  zone: string,
  instantSnapshotGroupName: string,
) =>
  getByName(project, zone, instantSnapshotGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new InstantSnapshotGroupStillExists({
              instantSnapshotGroupName,
              status: group.status ?? "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstantSnapshotGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const InstantSnapshotGroupProvider = () =>
  Provider.succeed(InstantSnapshotGroup, {
    stables: [
      "instantSnapshotGroupName",
      "project",
      "zone",
      "sourceConsistencyGroup",
      "instantSnapshotGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.instantSnapshotGroupName ?? output?.instantSnapshotGroupName;
      const nextName = news.instantSnapshotGroupName;
      const previousZone = zoneOf(olds?.zone ?? output?.zone);
      const nextZone = zoneOf(news.zone ?? output?.zone);
      const previousSource = lastSegment(
        olds?.sourceConsistencyGroup ?? output?.sourceConsistencyGroup,
      );
      const nextSource = lastSegment(news.sourceConsistencyGroup);
      if (
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousZone !== nextZone ||
        (nextSource && previousSource && previousSource !== nextSource)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName !== undefined &&
            previousName === nextName &&
            previousZone === nextZone,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotGroupName = yield* toName(
        id,
        olds?.instantSnapshotGroupName,
        output?.instantSnapshotGroupName,
      );
      const zone = zoneOf(olds?.zone ?? output?.zone);
      const existing = yield* getByName(
        env.project,
        zone,
        instantSnapshotGroupName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const perZone = yield* Effect.forEach(
          LIST_ZONES,
          (zone) =>
            compute.listInstantSnapshotGroups
              .items({
                project: env.project,
                zone,
                maxResults: 500,
                returnPartialSuccess: true,
              })
              .pipe(
                Stream.filter((group) => {
                  const { labels } = parseDescription(group.description);
                  return Object.keys(labels).some((key) =>
                    key.startsWith("alchemy-"),
                  );
                }),
                Stream.map((group) => toAttrs(group, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
          { concurrency: 4 },
        );
        return perZone.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotGroupName = yield* toName(
        id,
        news.instantSnapshotGroupName,
        output?.instantSnapshotGroupName,
      );
      const zone = zoneOf(news.zone ?? output?.zone);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);

      let current = yield* getByName(
        env.project,
        zone,
        instantSnapshotGroupName,
      );
      if (current?.status === "DELETING") {
        yield* waitGone(env.project, zone, instantSnapshotGroupName);
        current = undefined;
      }

      if (current === undefined) {
        yield* compute
          .insertInstantSnapshotGroups({
            project: env.project,
            zone,
            sourceConsistencyGroup: news.sourceConsistencyGroup,
            body: {
              name: instantSnapshotGroupName,
              description,
              sourceConsistencyGroup: news.sourceConsistencyGroup,
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
        current = yield* waitReady(env.project, zone, instantSnapshotGroupName);
      }

      if (current === undefined) {
        return yield* new InstantSnapshotGroupNotResolved({
          instantSnapshotGroupName,
          zone,
        });
      }

      if (current.status !== "READY") {
        current = yield* waitReady(env.project, zone, instantSnapshotGroupName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const zone = zoneOf(output.zone);
      const operation = yield* compute
        .deleteInstantSnapshotGroups({
          project: env.project,
          zone,
          instantSnapshotGroup: output.instantSnapshotGroupName,
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
      yield* waitGone(env.project, zone, output.instantSnapshotGroupName);
    }),
  });
