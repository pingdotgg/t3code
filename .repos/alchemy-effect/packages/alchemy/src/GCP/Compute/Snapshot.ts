import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  type WaitComputeOptions,
  waitGlobalOperation,
  waitRegionOperation,
  waitZoneOperation,
} from "./operations.ts";
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

export type SnapshotProps = {
  /**
   * Snapshot name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the snapshot.
   */
  snapshotName?: string;
  /**
   * Source disk URL or relative path used to create the snapshot
   * (`projects/{project}/zones/{zone}/disks/{disk}`,
   * `zones/{zone}/disks/{disk}`, or a full self-link). Immutable —
   * changing it replaces the snapshot.
   */
  sourceDisk: string;
  /**
   * Source instant snapshot URL. Immutable — changing it replaces the
   * snapshot. Mutually exclusive with creating from a different source
   * disk.
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

export type Snapshot = Resource<
  "GCP.Compute.Snapshot",
  SnapshotProps,
  {
    /** Snapshot name. */
    snapshotName: string;
    /** Server-assigned numeric id. */
    snapshotId: string | undefined;
    /** Project id. */
    project: string;
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
 * A global Compute Engine persistent-disk snapshot.
 *
 * Snapshots are created from a source disk (or instant snapshot). Name,
 * source, type, storage locations, chain name, and description are
 * immutable — changing them replaces the snapshot. Labels are updated
 * in place via `snapshots.setLabels`.
 *
 * ### Creating a Snapshot
 * **Example:** Snapshot of a disk
 * ```typescript
 * const disk = yield* GCP.Compute.Disk("data", {
 *   zone: "us-central1-a",
 *   sizeGb: 10,
 * });
 * const snapshot = yield* GCP.Compute.Snapshot("nightly", {
 *   sourceDisk: disk.selfLink,
 * });
 * ```
 *
 * **Example:** Explicit name, archive type, and labels
 * ```typescript
 * const snapshot = yield* GCP.Compute.Snapshot("nightly", {
 *   snapshotName: "app-data-nightly",
 *   sourceDisk: "zones/us-central1-a/disks/app-data",
 *   snapshotType: "ARCHIVE",
 *   storageLocations: ["us-central1"],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Snapshot = Resource<Snapshot>("GCP.Compute.Snapshot");

export class SnapshotNotResolved extends Data.TaggedError(
  "GCP.Compute.SnapshotNotResolved",
)<{
  snapshotName: string;
}> {}

export class SnapshotNotReady extends Data.TaggedError(
  "GCP.Compute.SnapshotNotReady",
)<{
  snapshotName: string;
  status: string;
}> {}

export class SnapshotFailed extends Data.TaggedError(
  "GCP.Compute.SnapshotFailed",
)<{
  snapshotName: string;
  status: string;
}> {}

export class SnapshotStillExists extends Data.TaggedError(
  "GCP.Compute.SnapshotStillExists",
)<{
  snapshotName: string;
  status: string;
}> {}

const DEFAULT_SNAPSHOT_TYPE = "STANDARD";

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
};

const canonicalizeSource = (source: string | undefined): string => {
  if (source === undefined || source.length === 0) return "";
  const cleaned = source.split("?")[0] ?? source;
  const zonal = cleaned.match(/(zones\/[^/]+\/disks\/[^/]+)$/);
  if (zonal?.[1] !== undefined) return zonal[1];
  const regional = cleaned.match(/(regions\/[^/]+\/disks\/[^/]+)$/);
  if (regional?.[1] !== undefined) return regional[1];
  const instant = cleaned.match(/(zones\/[^/]+\/instantSnapshots\/[^/]+)$/);
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

const getByName = (project: string, snapshot: string) =>
  compute
    .getSnapshots({ project, snapshot })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitSnapshotReady = (project: string, snapshotName: string) =>
  getByName(project, snapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot?.status === "FAILED"
        ? Effect.fail(new SnapshotFailed({ snapshotName, status: "FAILED" }))
        : Effect.succeed(snapshot),
    ),
    Effect.filterOrFail(
      (snapshot): snapshot is compute.Snapshot =>
        snapshot !== undefined && snapshot.status === "READY",
      (snapshot) =>
        new SnapshotNotReady({
          snapshotName,
          status: snapshot?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.SnapshotNotReady",
      times: 72,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitSnapshotGone = (project: string, snapshotName: string) =>
  getByName(project, snapshotName).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.void
        : Effect.fail(
            new SnapshotStillExists({
              snapshotName,
              status: snapshot.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof SnapshotStillExists,
      times: 18,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitSnapshotOperation = (
  project: string,
  operation: compute.Operation,
  options?: WaitComputeOptions,
) => {
  const zone = lastSegment(operation.zone);
  const region = lastSegment(operation.region);
  return zone !== undefined
    ? waitZoneOperation(project, zone, operation, options)
    : region !== undefined
      ? waitRegionOperation(project, region, operation, options)
      : waitGlobalOperation(project, operation, options);
};

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "project",
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

      const previousName = olds?.snapshotName ?? output?.snapshotName;
      const nextName = news.snapshotName ?? previousName;
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
      const existing = yield* getByName(env.project, snapshotName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listSnapshots
          .items({
            project: env.project,
            filter: "labels.alchemy-id:*",
            maxResults: 500,
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
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, snapshotName);
      if (current?.status === "DELETING") {
        yield* waitSnapshotGone(env.project, snapshotName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertSnapshots({
            project: env.project,
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
          yield* waitSnapshotOperation(env.project, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitSnapshotReady(env.project, snapshotName);
      }

      if (current === undefined) {
        return yield* new SnapshotNotResolved({ snapshotName });
      }

      if (current.status !== "READY") {
        current = yield* waitSnapshotReady(env.project, snapshotName);
      }

      if (current === undefined) {
        return yield* new SnapshotNotResolved({ snapshotName });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsSnapshots({
          project: env.project,
          resource: snapshotName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitSnapshotOperation(env.project, labeled);
        current = yield* getByName(env.project, snapshotName);
      }

      if (current === undefined) {
        return yield* new SnapshotNotResolved({ snapshotName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* compute
        .deleteSnapshots({
          project: output.project,
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
        yield* waitSnapshotOperation(output.project, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitSnapshotGone(output.project, output.snapshotName);
    }),
  });
