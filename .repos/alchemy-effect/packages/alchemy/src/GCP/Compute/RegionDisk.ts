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

export type RegionDiskProps = {
  /**
   * Disk name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the disk.
   */
  diskName?: string;
  /**
   * Region the disk lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the disk. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Zones the disk is replicated to. Two zones in `region` are required.
   * Short names (`us-central1-a`) or URLs are accepted. Immutable —
   * changing them replaces the disk.
   * @default ["{region}-a", "{region}-b"]
   */
  replicaZones?: string[];
  /**
   * Persistent disk type (`pd-standard`, `pd-balanced`, `pd-ssd`,
   * `pd-extreme`, `hyperdisk-balanced`, …). Immutable — changing it
   * replaces the disk.
   * @default "pd-standard"
   */
  type?: string;
  /**
   * Size in GB. Regional persistent disks require at least 200 GB. May
   * only grow in place; shrinking replaces the disk.
   * @default 200
   */
  sizeGb?: number;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Source image used to create the disk. Immutable — changing it replaces
   * the disk.
   */
  sourceImage?: string;
  /**
   * Source snapshot used to create the disk. Immutable — changing it
   * replaces the disk.
   */
  sourceSnapshot?: string;
  /**
   * Source disk used to create this disk. Immutable — changing it replaces
   * the disk.
   */
  sourceDisk?: string;
  /**
   * CPU architecture (`ARM64` or `X86_64`). Immutable — changing it
   * replaces the disk.
   */
  architecture?: string;
  /**
   * Physical block size in bytes (typically `4096`). Immutable — changing
   * it replaces the disk.
   */
  physicalBlockSizeBytes?: number;
  /**
   * Provisioned IOPS (Extreme PD / Hyperdisk). Mutable in place.
   */
  provisionedIops?: number;
  /**
   * Provisioned throughput in MB/s (Hyperdisk). Mutable in place.
   */
  provisionedThroughput?: number;
  /**
   * Whether confidential compute is enabled. Immutable — changing it
   * replaces the disk.
   */
  enableConfidentialCompute?: boolean;
};

export type RegionDisk = Resource<
  "GCP.Compute.RegionDisk",
  RegionDiskProps,
  {
    /** Disk name. */
    diskName: string;
    /** Server-assigned numeric id. */
    diskId: string | undefined;
    /** Project id. */
    project: string;
    /** Region (short name, e.g. `us-central1`). */
    region: string;
    /** Replica zone short names, sorted. */
    replicaZones: string[];
    /** Disk type (short name, e.g. `pd-standard`). */
    type: string;
    /** Size in GB. */
    sizeGb: number;
    /** Server-reported status (`READY`, `CREATING`, …). */
    status: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Optional description. */
    description: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Source image, if any. */
    sourceImage: string | undefined;
    /** Source snapshot, if any. */
    sourceSnapshot: string | undefined;
    /** Source disk, if any. */
    sourceDisk: string | undefined;
    /** Attached instance URLs. */
    users: ReadonlyArray<string>;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine persistent disk.
 *
 * Regional disks replicate across two zones in a region and require a
 * minimum size of 200 GB. Changing
 * `region`, `replicaZones`, `type`, `diskName`, `sourceImage`,
 * `sourceSnapshot`, `sourceDisk`, `architecture`,
 * `physicalBlockSizeBytes`, or `enableConfidentialCompute` replaces the
 * disk. Growing `sizeGb` is applied in place via `regionDisks.resize`;
 * shrinking it replaces the disk.
 *
 * ### Creating a RegionDisk
 * **Example:** Generated name
 * ```typescript
 * const disk = yield* GCP.Compute.RegionDisk("data", {});
 * ```
 *
 * **Example:** Explicit name, replica zones, type, size, and labels
 * ```typescript
 * const disk = yield* GCP.Compute.RegionDisk("data", {
 *   diskName: "app-data",
 *   region: "us-central1",
 *   replicaZones: ["us-central1-a", "us-central1-b"],
 *   type: "pd-balanced",
 *   sizeGb: 200,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Resizing a RegionDisk
 * **Example:** Grow in place
 * ```typescript
 * const disk = yield* GCP.Compute.RegionDisk("data", {
 *   diskName: "app-data",
 *   region: "us-central1",
 *   sizeGb: 250,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionDisk = Resource<RegionDisk>("GCP.Compute.RegionDisk");

export class RegionDiskNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionDiskNotResolved",
)<{
  diskName: string;
  region: string;
}> {}

export class RegionDiskNotReady extends Data.TaggedError(
  "GCP.Compute.RegionDiskNotReady",
)<{
  diskName: string;
  status: string;
}> {}

export class RegionDiskFailed extends Data.TaggedError(
  "GCP.Compute.RegionDiskFailed",
)<{
  diskName: string;
  status: string;
}> {}

export class RegionDiskStillExists extends Data.TaggedError(
  "GCP.Compute.RegionDiskStillExists",
)<{
  diskName: string;
  status: string;
}> {}

const DEFAULT_TYPE = "pd-standard";
const DEFAULT_SIZE_GB = 200;

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  (lastSegment(region ?? defaultRegion) ?? defaultRegion).toLowerCase();

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const parseSizeGb = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeReplicaZones = (
  region: string,
  zones: readonly string[] | undefined,
): string[] => {
  const raw =
    zones && zones.length > 0 ? zones : [`${region}-a`, `${region}-b`];
  return [
    ...new Set(
      raw
        .map((zone) => lastSegment(zone))
        .filter((zone): zone is string => zone !== undefined),
    ),
  ].sort();
};

const replicaZoneUrls = (project: string, zones: readonly string[]) =>
  zones.map((zone) => `projects/${project}/zones/${zone}`);

const replicaZonesEqual = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((zone, index) => zone === right[index]);

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    // RFC1035: disk names must start with a letter.
    return /^[a-z]/.test(generated) ? generated : `d${generated}`.slice(0, 63);
  });

const toAttrs = (disk: compute.Disk, project: string) => {
  const region = (lastSegment(disk.region) ?? "").toLowerCase();
  return {
    diskName: disk.name ?? disk.id ?? "",
    diskId: disk.id,
    project,
    region,
    replicaZones: normalizeReplicaZones(region, disk.replicaZones),
    type: lastSegment(disk.type) ?? DEFAULT_TYPE,
    sizeGb: parseSizeGb(disk.sizeGb),
    status: disk.status,
    labels: userLabels(disk.labels),
    description: disk.description,
    selfLink: disk.selfLink,
    creationTimestamp: disk.creationTimestamp,
    sourceImage: disk.sourceImage,
    sourceSnapshot: disk.sourceSnapshot,
    sourceDisk: disk.sourceDisk,
    users: disk.users ?? [],
  };
};

const getByName = (project: string, region: string, disk: string) =>
  compute
    .getRegionDisks({ project, region, disk })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitDiskReady = (project: string, region: string, diskName: string) =>
  getByName(project, region, diskName).pipe(
    Effect.flatMap((disk) =>
      disk?.status === "FAILED"
        ? Effect.fail(new RegionDiskFailed({ diskName, status: "FAILED" }))
        : Effect.succeed(disk),
    ),
    Effect.filterOrFail(
      (disk): disk is compute.Disk =>
        disk !== undefined && disk.status === "READY",
      (disk) =>
        new RegionDiskNotReady({
          diskName,
          status: disk?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RegionDiskNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitDiskGone = (project: string, region: string, diskName: string) =>
  getByName(project, region, diskName).pipe(
    Effect.flatMap((disk) =>
      disk === undefined
        ? Effect.void
        : Effect.fail(
            new RegionDiskStillExists({
              diskName,
              status: disk.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RegionDiskStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const diskTypeUrl = (project: string, region: string, type: string) =>
  `projects/${project}/regions/${region}/diskTypes/${type}`;

export const RegionDiskProvider = () =>
  Provider.succeed(RegionDisk, {
    stables: [
      "diskName",
      "diskId",
      "project",
      "region",
      "replicaZones",
      "type",
      "selfLink",
      "creationTimestamp",
      "sourceImage",
      "sourceSnapshot",
      "sourceDisk",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousType =
        lastSegment(olds?.type) ?? lastSegment(output?.type) ?? DEFAULT_TYPE;
      const nextType = lastSegment(news.type) ?? DEFAULT_TYPE;
      const previousName = olds?.diskName ?? output?.diskName;
      const nextName = news.diskName ?? previousName;
      const previousSize = olds?.sizeGb ?? output?.sizeGb;
      const nextSize = news.sizeGb ?? DEFAULT_SIZE_GB;
      const previousReplicas = normalizeReplicaZones(
        previousRegion,
        olds?.replicaZones ?? output?.replicaZones,
      );
      const nextReplicas = normalizeReplicaZones(nextRegion, news.replicaZones);

      const replace =
        previousRegion !== nextRegion ||
        previousType !== nextType ||
        !replicaZonesEqual(previousReplicas, nextReplicas) ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        (olds?.sourceImage ?? undefined) !== (news.sourceImage ?? undefined) ||
        (olds?.sourceSnapshot ?? undefined) !==
          (news.sourceSnapshot ?? undefined) ||
        (olds?.sourceDisk ?? undefined) !== (news.sourceDisk ?? undefined) ||
        (olds?.architecture ?? undefined) !==
          (news.architecture ?? undefined) ||
        (olds?.physicalBlockSizeBytes ?? undefined) !==
          (news.physicalBlockSizeBytes ?? undefined) ||
        (olds?.enableConfidentialCompute ?? undefined) !==
          (news.enableConfidentialCompute ?? undefined) ||
        (previousSize !== undefined && nextSize < previousSize);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName === previousName &&
          previousRegion === nextRegion,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const diskName = yield* toName(id, olds?.diskName, output?.diskName);
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, diskName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListDisks
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.disks ?? [])
              .filter((disk) => disk.region !== undefined)
              .filter((disk) =>
                Object.keys(disk.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((disk) => toAttrs(disk, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const diskName = yield* toName(id, news.diskName, output?.diskName);
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const diskType = lastSegment(news.type) ?? DEFAULT_TYPE;
      const sizeGb = news.sizeGb ?? DEFAULT_SIZE_GB;
      const replicaZones = normalizeReplicaZones(region, news.replicaZones);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, diskName);
      if (current?.status === "DELETING") {
        yield* waitDiskGone(env.project, region, diskName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertRegionDisks({
            project: env.project,
            region,
            body: {
              name: diskName,
              sizeGb: String(sizeGb),
              type: diskTypeUrl(env.project, region, diskType),
              replicaZones: replicaZoneUrls(env.project, replicaZones),
              description: news.description,
              labels: desiredLabels,
              sourceImage: news.sourceImage,
              sourceSnapshot: news.sourceSnapshot,
              sourceDisk: news.sourceDisk,
              architecture: news.architecture,
              physicalBlockSizeBytes:
                news.physicalBlockSizeBytes !== undefined
                  ? String(news.physicalBlockSizeBytes)
                  : undefined,
              provisionedIops:
                news.provisionedIops !== undefined
                  ? String(news.provisionedIops)
                  : undefined,
              provisionedThroughput:
                news.provisionedThroughput !== undefined
                  ? String(news.provisionedThroughput)
                  : undefined,
              enableConfidentialCompute: news.enableConfidentialCompute,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitRegionOperation(env.project, region, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitDiskReady(env.project, region, diskName);
      }

      if (current === undefined) {
        return yield* new RegionDiskNotResolved({ diskName, region });
      }

      const observedSize = parseSizeGb(current.sizeGb);
      if (sizeGb > observedSize) {
        const resized = yield* compute.resizeRegionDisks({
          project: env.project,
          region,
          disk: diskName,
          body: { sizeGb: String(sizeGb) },
        });
        yield* waitRegionOperation(env.project, region, resized);
        current = yield* waitDiskReady(env.project, region, diskName);
      }

      if (current === undefined) {
        return yield* new RegionDiskNotResolved({ diskName, region });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsRegionDisks({
          project: env.project,
          region,
          resource: diskName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitRegionOperation(env.project, region, labeled);
        current = yield* getByName(env.project, region, diskName);
      }

      if (current === undefined) {
        return yield* new RegionDiskNotResolved({ diskName, region });
      }

      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const iopsChanged =
        news.provisionedIops !== undefined &&
        String(news.provisionedIops) !== (current.provisionedIops ?? "");
      const throughputChanged =
        news.provisionedThroughput !== undefined &&
        String(news.provisionedThroughput) !==
          (current.provisionedThroughput ?? "");

      if (descriptionChanged || iopsChanged || throughputChanged) {
        const updated = yield* compute.updateRegionDisks({
          project: env.project,
          region,
          disk: diskName,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            iopsChanged ? "provisionedIops" : undefined,
            throughputChanged ? "provisionedThroughput" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            description: news.description,
            provisionedIops:
              news.provisionedIops !== undefined
                ? String(news.provisionedIops)
                : undefined,
            provisionedThroughput:
              news.provisionedThroughput !== undefined
                ? String(news.provisionedThroughput)
                : undefined,
          },
        });
        yield* waitRegionOperation(env.project, region, updated);
        current = yield* getByName(env.project, region, diskName);
      }

      if (current === undefined) {
        return yield* new RegionDiskNotResolved({ diskName, region });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* compute
        .deleteRegionDisks({
          project: output.project,
          region: output.region,
          disk: output.diskName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (deleted !== undefined) {
        yield* waitRegionOperation(output.project, output.region, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitDiskGone(output.project, output.region, output.diskName);
    }),
  });
