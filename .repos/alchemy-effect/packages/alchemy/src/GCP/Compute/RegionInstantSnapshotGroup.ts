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

export type RegionInstantSnapshotGroupProps = {
  /**
   * Instant snapshot group name (RFC1035, 1-63 characters). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Changing it replaces the group.
   */
  instantSnapshotGroupName?: string;
  /**
   * Region the group lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the group. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Disk consistency-group resource policy used as the source. Accepts a
   * ResourcePolicy self-link, a
   * `projects/{project}/regions/{region}/resourcePolicies/{name}` path, or
   * the policy name. Immutable — changing it replaces the group. Member
   * disks must already be attached to the consistency group.
   */
  sourceConsistencyGroup: string;
  /**
   * Optional description. Instant snapshot groups have no labels field
   * and no update API, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and any description change replaces the group.
   */
  description?: string;
};

export type RegionInstantSnapshotGroup = Resource<
  "GCP.Compute.RegionInstantSnapshotGroup",
  RegionInstantSnapshotGroupProps,
  {
    /** Instant snapshot group name. */
    instantSnapshotGroupName: string;
    /** Server-assigned numeric id. */
    instantSnapshotGroupId: string | undefined;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Source consistency-group resource policy URL. */
    sourceConsistencyGroup: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported status (`READY`, `CREATING`, …). */
    status: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the resource id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine instant snapshot group.
 *
 * An instant snapshot group is a crash-consistent set of instant snapshots
 * taken from every disk in a disk consistency group (a ResourcePolicy
 * with `diskConsistencyGroupPolicy`). There is no update API and no
 * labels field — Alchemy stamps ownership into the description so nuke
 * can find leaked groups, and every user-facing field change replaces
 * the resource.
 *
 * ### Creating a Regional Instant Snapshot Group
 * **Example:** Snapshot a consistency group
 * ```typescript
 * const policy = yield* GCP.Compute.ResourcePolicy("cg", {
 *   region: "us-central1",
 *   diskConsistencyGroupPolicy: {},
 * });
 * const group = yield* GCP.Compute.RegionInstantSnapshotGroup("ckpt", {
 *   region: "us-central1",
 *   sourceConsistencyGroup: policy.resourcePolicyName,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionInstantSnapshotGroup = Resource<RegionInstantSnapshotGroup>(
  "GCP.Compute.RegionInstantSnapshotGroup",
);

export class RegionInstantSnapshotGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotGroupNotResolved",
)<{
  instantSnapshotGroupName: string;
  region: string;
}> {}

export class RegionInstantSnapshotGroupNotReady extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotGroupNotReady",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

export class RegionInstantSnapshotGroupFailed extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotGroupFailed",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

export class RegionInstantSnapshotGroupStillExists extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotGroupStillExists",
)<{
  instantSnapshotGroupName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string => {
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
    return /^[a-z]/.test(generated) ? generated : `g${generated}`.slice(0, 63);
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

const toPolicyRef = (
  project: string,
  region: string,
  policy: string,
): string => {
  if (policy.includes("/")) return policy;
  return `projects/${project}/regions/${region}/resourcePolicies/${policy}`;
};

const canonicalizePolicy = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const cleaned = value.split("?")[0] ?? value;
  const match = cleaned.match(/(regions\/[^/]+\/resourcePolicies\/[^/]+)$/);
  if (match?.[1] !== undefined) return match[1];
  return lastSegment(cleaned);
};

const toAttrs = (group: compute.InstantSnapshotGroup, project: string) => {
  const parsed = parseDescription(group.description);
  return {
    instantSnapshotGroupName: group.name ?? group.id ?? "",
    instantSnapshotGroupId: group.id,
    project,
    region: lastSegment(group.region).toLowerCase(),
    sourceConsistencyGroup: group.sourceConsistencyGroup,
    description: parsed.description,
    status: group.status,
    selfLink: group.selfLink,
    selfLinkWithId: group.selfLinkWithId,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  instantSnapshotGroup: string,
) =>
  compute
    .getRegionInstantSnapshotGroups({
      project,
      region,
      instantSnapshotGroup,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitReady = (
  project: string,
  region: string,
  instantSnapshotGroupName: string,
) =>
  getByName(project, region, instantSnapshotGroupName).pipe(
    Effect.flatMap((group) =>
      group?.status === "FAILED" || group?.status === "INVALID"
        ? Effect.fail(
            new RegionInstantSnapshotGroupFailed({
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
        new RegionInstantSnapshotGroupNotReady({
          instantSnapshotGroupName,
          status: group?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionInstantSnapshotGroupNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitGone = (
  project: string,
  region: string,
  instantSnapshotGroupName: string,
) =>
  getByName(project, region, instantSnapshotGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new RegionInstantSnapshotGroupStillExists({
              instantSnapshotGroupName,
              status: group.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof RegionInstantSnapshotGroupStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const RegionInstantSnapshotGroupProvider = () =>
  Provider.succeed(RegionInstantSnapshotGroup, {
    stables: [
      "instantSnapshotGroupName",
      "instantSnapshotGroupId",
      "project",
      "region",
      "sourceConsistencyGroup",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName =
        olds?.instantSnapshotGroupName ?? output?.instantSnapshotGroupName;
      const nextName = news.instantSnapshotGroupName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousSource = canonicalizePolicy(
        olds?.sourceConsistencyGroup ?? output?.sourceConsistencyGroup,
      );
      const nextSource = canonicalizePolicy(news.sourceConsistencyGroup);
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";

      const replace =
        previousRegion !== nextRegion ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        (nextSource.length > 0 &&
          previousSource.length > 0 &&
          previousSource !== nextSource) ||
        previousDescription !== nextDescription;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousRegion === nextRegion &&
          previousName !== undefined &&
          nextName !== undefined &&
          previousName === nextName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotGroupName = yield* toName(
        id,
        olds?.instantSnapshotGroupName,
        output?.instantSnapshotGroupName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
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
        return yield* compute.listRegionInstantSnapshotGroups
          .items({
            project: env.project,
            region: env.region,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((group) => hasOwnershipMarker(group.description)),
            Stream.map((group) => toAttrs(group, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotGroupName = yield* toName(
        id,
        news.instantSnapshotGroupName,
        output?.instantSnapshotGroupName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredSource = toPolicyRef(
        env.project,
        region,
        news.sourceConsistencyGroup,
      );

      let current = yield* getByName(
        env.project,
        region,
        instantSnapshotGroupName,
      );
      if (current?.status === "DELETING") {
        yield* waitGone(env.project, region, instantSnapshotGroupName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertRegionInstantSnapshotGroups({
            project: env.project,
            region,
            sourceConsistencyGroup: desiredSource,
            body: {
              name: instantSnapshotGroupName,
              description: desiredDescription,
              sourceConsistencyGroup: desiredSource,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitRegionOperation(env.project, region, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitReady(
          env.project,
          region,
          instantSnapshotGroupName,
        );
      }

      if (current === undefined) {
        return yield* new RegionInstantSnapshotGroupNotResolved({
          instantSnapshotGroupName,
          region,
        });
      }

      if (current.status !== "READY") {
        current = yield* waitReady(
          env.project,
          region,
          instantSnapshotGroupName,
        );
      }

      if (current === undefined) {
        return yield* new RegionInstantSnapshotGroupNotResolved({
          instantSnapshotGroupName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const deleted = yield* compute
        .deleteRegionInstantSnapshotGroups({
          project: output.project,
          region,
          instantSnapshotGroup: output.instantSnapshotGroupName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitRegionOperation(output.project, region, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitGone(output.project, region, output.instantSnapshotGroupName);
    }),
  });
