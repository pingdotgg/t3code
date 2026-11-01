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

const DEFAULT_SNAPSHOT_TYPE = "STANDARD";

export type RegionSnapshotProps = {
  /**
   * Snapshot name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the snapshot.
   */
  snapshotName?: string;
  /**
   * Region the snapshot lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the snapshot. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Source regional disk URL or relative path used to create the snapshot
   * (`projects/{project}/regions/{region}/disks/{disk}`,
   * `regions/{region}/disks/{disk}`, or a full self-link). Immutable —
   * changing it replaces the snapshot.
   */
  sourceDisk: string;
  /**
   * Source instant snapshot URL. Immutable — changing it replaces the
   * snapshot.
   */
  sourceInstantSnapshot?: string;
  /**
   * Optional description. Immutable — changing it replaces the snapshot.
   */
  description?: string;
  /**
   * Snapshot type (`STANDARD` or `ARCHIVE`). Immutable — changing it
   * replaces the snapshot.
   * @default "STANDARD"
   */
  snapshotType?: compute.SnapshotSnapshotTypeEnum | (string & {});
  /**
   * Cloud Storage locations to store the snapshot (regional or
   * multi-regional codes such as `us-central1` or `us`). Immutable —
   * changing it replaces the snapshot.
   */
  storageLocations?: string[];
  /**
   * Snapshot chain name for advanced chargeback tracking. Immutable —
   * changing it replaces the snapshot.
   */
  chainName?: string;
  /**
   * Attempt an application-consistent snapshot by flushing the guest OS.
   * Input-only; not persisted on the resource.
   */
  guestFlush?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RegionSnapshot = Resource<
  "GCP.Compute.RegionSnapshot",
  RegionSnapshotProps,
  {
    /** Snapshot name. */
    snapshotName: string;
    /** Server-assigned numeric id. */
    snapshotId: string | undefined;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Source disk URL. */
    sourceDisk: string | undefined;
    /** Server-assigned source disk id. */
    sourceDiskId: string | undefined;
    /** Source instant snapshot URL, if any. */
    sourceInstantSnapshot: string | undefined;
    /** Snapshot type (`STANDARD` or `ARCHIVE`). */
    snapshotType: string | undefined;
    /** Cloud Storage locations. */
    storageLocations: string[];
    /** Snapshot chain name, if set. */
    chainName: string | undefined;
    /** Optional description. */
    description: string | undefined;
    /** Server-reported status (`READY`, `CREATING`, …). */
    status: string | undefined;
    /** Size of the source disk in GB. */
    diskSizeGb: string | undefined;
    /** Storage used by the snapshot, in bytes. */
    storageBytes: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine persistent-disk snapshot.
 *
 * Regional snapshots are created from a regional disk (or instant
 * snapshot) and stored in the same region. Name, source, type, storage
 * locations, chain name, description, and region are immutable —
 * changing them replaces the snapshot. Labels are updated in place via
 * `regionSnapshots.setLabels`.
 *
 * ### Creating a Regional Snapshot
 * **Example:** Snapshot of a regional disk
 * ```typescript
 * const disk = yield* GCP.Compute.RegionDisk("data", {
 *   region: "us-central1",
 *   sizeGb: 200,
 * });
 * const snapshot = yield* GCP.Compute.RegionSnapshot("nightly", {
 *   region: "us-central1",
 *   sourceDisk: disk.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionSnapshot = Resource<RegionSnapshot>(
  "GCP.Compute.RegionSnapshot",
);

export class RegionSnapshotNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionSnapshotNotResolved",
)<{
  snapshotName: string;
  region: string;
}> {}

export class RegionSnapshotNotReady extends Data.TaggedError(
  "GCP.Compute.RegionSnapshotNotReady",
)<{
  snapshotName: string;
  status: string;
}> {}

export class RegionSnapshotFailed extends Data.TaggedError(
  "GCP.Compute.RegionSnapshotFailed",
)<{
  snapshotName: string;
  status: string;
}> {}

export class RegionSnapshotStillExists extends Data.TaggedError(
  "GCP.Compute.RegionSnapshotStillExists",
)<{
  snapshotName: string;
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
  const zonal = cleaned.match(/(zones\/[^/]+\/disks\/[^/]+)$/);
  if (zonal?.[1] !== undefined) return zonal[1];
  const regional = cleaned.match(/(regions\/[^/]+\/disks\/[^/]+)$/);
  if (regional?.[1] !== undefined) return regional[1];
  const instant = cleaned.match(
    /((?:zones|regions)\/[^/]+\/instantSnapshots\/[^/]+)$/,
  );
  if (instant?.[1] !== undefined) return instant[1];
  return cleaned.replace(/^https?:\/\/[^/]+\//, "");
};

const sameLocations = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => {
  const a = [...(left ?? [])].map((value) => value.toLowerCase()).sort();
  const b = [...(right ?? [])].map((value) => value.toLowerCase()).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
    return /^[a-z]/.test(generated) ? generated : `s${generated}`.slice(0, 63);
  });

const toAttrs = (snapshot: compute.Snapshot, project: string) => ({
  snapshotName: snapshot.name ?? snapshot.id ?? "",
  snapshotId: snapshot.id,
  project,
  region: (lastSegment(snapshot.region) ?? "").toLowerCase(),
  sourceDisk: snapshot.sourceDisk,
  sourceDiskId: snapshot.sourceDiskId,
  sourceInstantSnapshot: snapshot.sourceInstantSnapshot,
  snapshotType: snapshot.snapshotType,
  storageLocations: snapshot.storageLocations ?? [],
  chainName: snapshot.chainName,
  description: snapshot.description,
  status: snapshot.status,
  diskSizeGb: snapshot.diskSizeGb,
  storageBytes: snapshot.storageBytes,
  labels: userLabels(snapshot.labels),
  selfLink: snapshot.selfLink,
  creationTimestamp: snapshot.creationTimestamp,
});

const getByName = (project: string, region: string, snapshot: string) =>
  compute
    .getRegionSnapshots({ project, region, snapshot })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitSnapshotReady = (
  project: string,
  region: string,
  snapshotName: string,
) =>
  getByName(project, region, snapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot?.status === "FAILED"
        ? Effect.fail(
            new RegionSnapshotFailed({ snapshotName, status: "FAILED" }),
          )
        : Effect.succeed(snapshot),
    ),
    Effect.filterOrFail(
      (snapshot): snapshot is compute.Snapshot =>
        snapshot !== undefined && snapshot.status === "READY",
      (snapshot) =>
        new RegionSnapshotNotReady({
          snapshotName,
          status: snapshot?.status ?? "MISSING",
        }),
    ),
    // Snapshot uploads routinely take a few minutes to reach READY.
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RegionSnapshotNotReady",
      times: 72,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitSnapshotGone = (
  project: string,
  region: string,
  snapshotName: string,
) =>
  getByName(project, region, snapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.void
        : Effect.fail(
            new RegionSnapshotStillExists({
              snapshotName,
              status: snapshot.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof RegionSnapshotStillExists,
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const RegionSnapshotProvider = () =>
  Provider.succeed(RegionSnapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "project",
      "region",
      "sourceDisk",
      "sourceDiskId",
      "sourceInstantSnapshot",
      "snapshotType",
      "storageLocations",
      "chainName",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName = olds?.snapshotName ?? output?.snapshotName;
      const nextName = news.snapshotName ?? previousName;
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
      const previousInstant = canonicalizeSource(
        olds?.sourceInstantSnapshot ?? output?.sourceInstantSnapshot,
      );
      const nextInstant = canonicalizeSource(news.sourceInstantSnapshot);
      const previousType =
        olds?.snapshotType ?? output?.snapshotType ?? DEFAULT_SNAPSHOT_TYPE;
      const nextType = news.snapshotType ?? DEFAULT_SNAPSHOT_TYPE;
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";
      const previousChain = olds?.chainName ?? output?.chainName ?? "";
      const nextChain = news.chainName ?? "";
      const locationsSpecified = news.storageLocations !== undefined;
      const locationsChanged =
        locationsSpecified &&
        !sameLocations(
          news.storageLocations,
          olds?.storageLocations ?? output?.storageLocations,
        );

      const replace =
        previousRegion !== nextRegion ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        (nextSource.length > 0 &&
          previousSource.length > 0 &&
          previousSource !== nextSource) ||
        previousInstant !== nextInstant ||
        previousType !== nextType ||
        previousDescription !== nextDescription ||
        previousChain !== nextChain ||
        locationsChanged;

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
      const snapshotName = yield* toName(
        id,
        olds?.snapshotName,
        output?.snapshotName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, snapshotName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listRegionSnapshots
          .items({
            project: env.project,
            region: env.region,
            filter: "labels.alchemy-id:*",
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((snapshot) =>
              Object.keys(snapshot.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((snapshot) => toAttrs(snapshot, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const snapshotName = yield* toName(
        id,
        news.snapshotName,
        output?.snapshotName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, snapshotName);
      if (current?.status === "DELETING") {
        yield* waitSnapshotGone(env.project, region, snapshotName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertRegionSnapshots({
            project: env.project,
            region,
            body: {
              name: snapshotName,
              sourceDisk: news.sourceDisk,
              sourceInstantSnapshot: news.sourceInstantSnapshot,
              description: news.description,
              labels: desiredLabels,
              snapshotType: news.snapshotType,
              storageLocations: news.storageLocations,
              chainName: news.chainName,
              guestFlush: news.guestFlush,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitRegionOperation(env.project, region, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitSnapshotReady(env.project, region, snapshotName);
      }

      if (current === undefined) {
        return yield* new RegionSnapshotNotResolved({ snapshotName, region });
      }

      if (current.status !== "READY") {
        current = yield* waitSnapshotReady(env.project, region, snapshotName);
      }

      if (current === undefined) {
        return yield* new RegionSnapshotNotResolved({ snapshotName, region });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsRegionSnapshots({
          project: env.project,
          region,
          resource: snapshotName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitRegionOperation(env.project, region, labeled);
        current = yield* getByName(env.project, region, snapshotName);
      }

      if (current === undefined) {
        return yield* new RegionSnapshotNotResolved({ snapshotName, region });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const deleted = yield* compute
        .deleteRegionSnapshots({
          project: output.project,
          region,
          snapshot: output.snapshotName,
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
      yield* waitSnapshotGone(output.project, region, output.snapshotName);
    }),
  });
