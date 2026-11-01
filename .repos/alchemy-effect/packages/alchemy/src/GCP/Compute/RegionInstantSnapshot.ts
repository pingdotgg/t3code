import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import { OperationFailed } from "../Operation.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type RegionInstantSnapshotProps = {
  /**
   * Instant snapshot name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the snapshot.
   */
  instantSnapshotName?: string;
  /**
   * Region the instant snapshot lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the snapshot. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Source regional disk URL or relative path used to create the instant
   * snapshot (`projects/{project}/regions/{region}/disks/{disk}`,
   * `regions/{region}/disks/{disk}`, or a full self-link). Immutable —
   * changing it replaces the snapshot.
   */
  sourceDisk: string;
  /**
   * Optional description. Immutable — changing it replaces the snapshot.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RegionInstantSnapshot = Resource<
  "GCP.Compute.RegionInstantSnapshot",
  RegionInstantSnapshotProps,
  {
    /** Instant snapshot name. */
    instantSnapshotName: string;
    /** Server-assigned numeric id. */
    instantSnapshotId: string | undefined;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Source disk URL. */
    sourceDisk: string | undefined;
    /** Server-assigned source disk id. */
    sourceDiskId: string | undefined;
    /** Optional description. */
    description: string | undefined;
    /** Server-reported status (`READY`, `CREATING`, …). */
    status: string | undefined;
    /** Size of the source disk in GB. */
    diskSizeGb: string | undefined;
    /** Architecture (`ARM64` or `X86_64`), if known. */
    architecture: string | undefined;
    /** Instant snapshot group this snapshot belongs to, if any. */
    sourceInstantSnapshotGroup: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Compute Engine self-link. */
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
 * A regional Compute Engine instant snapshot.
 *
 * Instant snapshots are crash-consistent rollback points of a regional
 * disk. Name, source disk, description, and region are immutable —
 * changing them replaces the snapshot. Labels are updated in place via
 * `regionInstantSnapshots.setLabels`.
 *
 * ### Creating a Regional Instant Snapshot
 * **Example:** Instant snapshot of a regional disk
 * ```typescript
 * const disk = yield* GCP.Compute.RegionDisk("data", {
 *   region: "us-central1",
 *   sizeGb: 200,
 * });
 * const snapshot = yield* GCP.Compute.RegionInstantSnapshot("checkpoint", {
 *   region: "us-central1",
 *   sourceDisk: disk.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionInstantSnapshot = Resource<RegionInstantSnapshot>(
  "GCP.Compute.RegionInstantSnapshot",
);

export class RegionInstantSnapshotNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotNotResolved",
)<{
  instantSnapshotName: string;
  region: string;
}> {}

export class RegionInstantSnapshotNotReady extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotNotReady",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

export class RegionInstantSnapshotFailed extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotFailed",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

export class RegionInstantSnapshotStillExists extends Data.TaggedError(
  "GCP.Compute.RegionInstantSnapshotStillExists",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  (lastSegment(region ?? defaultRegion) ?? defaultRegion).toLowerCase();

const canonicalizeSource = (source: string | undefined): string => {
  if (source === undefined || source.length === 0) return "";
  const cleaned = source.split("?")[0] ?? source;
  const regional = cleaned.match(/(regions\/[^/]+\/disks\/[^/]+)$/);
  if (regional?.[1] !== undefined) return regional[1];
  const zonal = cleaned.match(/(zones\/[^/]+\/disks\/[^/]+)$/);
  if (zonal?.[1] !== undefined) return zonal[1];
  return cleaned.replace(/^https?:\/\/[^/]+\//, "");
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `i${generated}`.slice(0, 63);
  });

const toAttrs = (snapshot: compute.InstantSnapshot, project: string) => ({
  instantSnapshotName: snapshot.name ?? snapshot.id ?? "",
  instantSnapshotId: snapshot.id,
  project,
  region: (lastSegment(snapshot.region) ?? "").toLowerCase(),
  sourceDisk: snapshot.sourceDisk,
  sourceDiskId: snapshot.sourceDiskId,
  description: snapshot.description,
  status: snapshot.status,
  diskSizeGb: snapshot.diskSizeGb,
  architecture: snapshot.architecture,
  sourceInstantSnapshotGroup: snapshot.sourceInstantSnapshotGroup,
  labels: userLabels(snapshot.labels),
  selfLink: snapshot.selfLink,
  selfLinkWithId: snapshot.selfLinkWithId,
  creationTimestamp: snapshot.creationTimestamp,
  kind: snapshot.kind,
});

const getByName = (project: string, region: string, instantSnapshot: string) =>
  compute
    .getRegionInstantSnapshots({ project, region, instantSnapshot })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitReady = (
  project: string,
  region: string,
  instantSnapshotName: string,
) =>
  getByName(project, region, instantSnapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot?.status === "FAILED"
        ? Effect.fail(
            new RegionInstantSnapshotFailed({
              instantSnapshotName,
              status: "FAILED",
            }),
          )
        : Effect.succeed(snapshot),
    ),
    Effect.filterOrFail(
      (snapshot): snapshot is compute.InstantSnapshot =>
        snapshot !== undefined && snapshot.status === "READY",
      (snapshot) =>
        new RegionInstantSnapshotNotReady({
          instantSnapshotName,
          status: snapshot?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionInstantSnapshotNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitGone = (
  project: string,
  region: string,
  instantSnapshotName: string,
) =>
  getByName(project, region, instantSnapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.void
        : Effect.fail(
            new RegionInstantSnapshotStillExists({
              instantSnapshotName,
              status: snapshot.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof RegionInstantSnapshotStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const RegionInstantSnapshotProvider = () =>
  Provider.succeed(RegionInstantSnapshot, {
    stables: [
      "instantSnapshotName",
      "instantSnapshotId",
      "project",
      "region",
      "sourceDisk",
      "sourceDiskId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName =
        olds?.instantSnapshotName ?? output?.instantSnapshotName;
      const nextName = news.instantSnapshotName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousSource = canonicalizeSource(
        olds?.sourceDisk ?? output?.sourceDisk,
      );
      const nextSource = canonicalizeSource(news.sourceDisk);
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
      const instantSnapshotName = yield* toName(
        id,
        olds?.instantSnapshotName,
        output?.instantSnapshotName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        instantSnapshotName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstantSnapshots
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.instantSnapshots ?? [])
              .filter((snapshot) => (snapshot.region ?? "").length > 0)
              .filter((snapshot) =>
                Object.keys(snapshot.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((snapshot) => toAttrs(snapshot, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotName = yield* toName(
        id,
        news.instantSnapshotName,
        output?.instantSnapshotName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, instantSnapshotName);
      if (current?.status === "DELETING") {
        yield* waitGone(env.project, region, instantSnapshotName);
        current = undefined;
      }

      if (current === undefined) {
        // A replacement snapshots the same disk again; Compute rejects a
        // second instant snapshot within 30s of the previous one.
        // "The previous instant snapshot is too recent" — one instant snapshot
        // per disk every 30 seconds.
        const tooRecent = (error: { readonly _tag: string }) =>
          error instanceof OperationFailed &&
          error.reason === "UNSUPPORTED_OPERATION";
        yield* compute
          .insertRegionInstantSnapshots({
            project: env.project,
            region,
            body: {
              name: instantSnapshotName,
              sourceDisk: news.sourceDisk,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.flatMap((inserted) =>
              inserted === undefined
                ? Effect.void
                : waitRegionOperation(env.project, region, inserted, {
                    ignore: ["RESOURCE_ALREADY_EXISTS"],
                  }),
            ),
            Effect.retry({
              while: tooRecent,
              times: 3,
              schedule: Schedule.spaced("30 seconds"),
            }),
          );
        current = yield* waitReady(env.project, region, instantSnapshotName);
      }

      if (current === undefined) {
        return yield* new RegionInstantSnapshotNotResolved({
          instantSnapshotName,
          region,
        });
      }

      if (current.status !== "READY") {
        current = yield* waitReady(env.project, region, instantSnapshotName);
      }

      if (current === undefined) {
        return yield* new RegionInstantSnapshotNotResolved({
          instantSnapshotName,
          region,
        });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsRegionInstantSnapshots({
          project: env.project,
          region,
          resource: instantSnapshotName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitRegionOperation(env.project, region, labeled);
        current = yield* getByName(env.project, region, instantSnapshotName);
      }

      if (current === undefined) {
        return yield* new RegionInstantSnapshotNotResolved({
          instantSnapshotName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const deleted = yield* compute
        .deleteRegionInstantSnapshots({
          project: output.project,
          region,
          instantSnapshot: output.instantSnapshotName,
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
      yield* waitGone(output.project, region, output.instantSnapshotName);
    }),
  });
