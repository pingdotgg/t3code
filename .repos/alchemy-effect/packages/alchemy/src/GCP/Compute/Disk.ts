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

export type DiskProps = {
  /**
   * Disk name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the disk.
   */
  diskName?: string;
  /**
   * Zone the disk lives in (e.g. `us-central1-a`). Immutable — changing it
   * replaces the disk.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Persistent disk type (`pd-standard`, `pd-balanced`, `pd-ssd`,
   * `pd-extreme`, `hyperdisk-balanced`, …). Immutable — changing it
   * replaces the disk.
   * @default "pd-standard"
   */
  type?: string;
  /**
   * Size in GB. May only grow in place; shrinking replaces the disk.
   * @default 10
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

export type Disk = Resource<
  "GCP.Compute.Disk",
  DiskProps,
  {
    /** Disk name. */
    diskName: string;
    /** Server-assigned numeric id. */
    diskId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone (short name, e.g. `us-central1-a`). */
    zone: string;
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
 * A zonal Compute Engine persistent disk.
 *
 * Changing `zone`, `type`, `diskName`, `sourceImage`, `sourceSnapshot`,
 * `sourceDisk`, `architecture`, `physicalBlockSizeBytes`, or
 * `enableConfidentialCompute` replaces the disk. Growing `sizeGb` is
 * applied in place via `disks.resize`; shrinking it replaces the disk.
 *
 * ### Creating a Disk
 * **Example:** Generated name
 * ```typescript
 * const disk = yield* GCP.Compute.Disk("data", {});
 * ```
 *
 * **Example:** Explicit name, type, size, and labels
 * ```typescript
 * const disk = yield* GCP.Compute.Disk("data", {
 *   diskName: "app-data",
 *   zone: "us-central1-a",
 *   type: "pd-balanced",
 *   sizeGb: 20,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Resizing a Disk
 * **Example:** Grow in place
 * ```typescript
 * const disk = yield* GCP.Compute.Disk("data", {
 *   diskName: "app-data",
 *   sizeGb: 50,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Disk = Resource<Disk>("GCP.Compute.Disk");

export class DiskNotResolved extends Data.TaggedError(
  "GCP.Compute.DiskNotResolved",
)<{
  diskName: string;
  zone: string;
}> {}

export class DiskNotReady extends Data.TaggedError("GCP.Compute.DiskNotReady")<{
  diskName: string;
  status: string;
}> {}

export class DiskFailed extends Data.TaggedError("GCP.Compute.DiskFailed")<{
  diskName: string;
  status: string;
}> {}

export class DiskStillExists extends Data.TaggedError(
  "GCP.Compute.DiskStillExists",
)<{
  diskName: string;
  status: string;
}> {}

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_TYPE = "pd-standard";
const DEFAULT_SIZE_GB = 10;

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const parseSizeGb = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

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

const toAttrs = (disk: compute.Disk, project: string) => ({
  diskName: disk.name ?? disk.id ?? "",
  diskId: disk.id,
  project,
  zone: lastSegment(disk.zone) ?? DEFAULT_ZONE,
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
});

const getByName = (project: string, zone: string, disk: string) =>
  compute
    .getDisks({ project, zone, disk })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitDiskReady = (project: string, zone: string, diskName: string) =>
  getByName(project, zone, diskName).pipe(
    Effect.flatMap((disk) =>
      disk?.status === "FAILED"
        ? Effect.fail(new DiskFailed({ diskName, status: "FAILED" }))
        : Effect.succeed(disk),
    ),
    Effect.filterOrFail(
      (disk): disk is compute.Disk =>
        disk !== undefined && disk.status === "READY",
      (disk) =>
        new DiskNotReady({
          diskName,
          status: disk?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.DiskNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitDiskGone = (project: string, zone: string, diskName: string) =>
  getByName(project, zone, diskName).pipe(
    Effect.flatMap((disk) =>
      disk === undefined
        ? Effect.void
        : Effect.fail(
            new DiskStillExists({
              diskName,
              status: disk.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof DiskStillExists,
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const diskTypeUrl = (project: string, zone: string, type: string) =>
  `projects/${project}/zones/${zone}/diskTypes/${type}`;

export const DiskProvider = () =>
  Provider.succeed(Disk, {
    stables: [
      "diskName",
      "diskId",
      "project",
      "zone",
      "type",
      "selfLink",
      "creationTimestamp",
      "sourceImage",
      "sourceSnapshot",
      "sourceDisk",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousZone =
        lastSegment(olds?.zone) ?? lastSegment(output?.zone) ?? DEFAULT_ZONE;
      const nextZone = lastSegment(news.zone) ?? DEFAULT_ZONE;
      const previousType =
        lastSegment(olds?.type) ?? lastSegment(output?.type) ?? DEFAULT_TYPE;
      const nextType = lastSegment(news.type) ?? DEFAULT_TYPE;
      const previousName = olds?.diskName ?? output?.diskName;
      const nextName = news.diskName ?? previousName;
      const previousSize = olds?.sizeGb ?? output?.sizeGb;
      const nextSize = news.sizeGb ?? DEFAULT_SIZE_GB;

      const replace =
        previousZone !== nextZone ||
        previousType !== nextType ||
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
          previousZone === nextZone,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const diskName = yield* toName(id, olds?.diskName, output?.diskName);
      const zone =
        lastSegment(olds?.zone) ?? lastSegment(output?.zone) ?? DEFAULT_ZONE;
      const existing = yield* getByName(env.project, zone, diskName);
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
      const zone =
        lastSegment(news.zone) ?? lastSegment(output?.zone) ?? DEFAULT_ZONE;
      const diskType = lastSegment(news.type) ?? DEFAULT_TYPE;
      const sizeGb = news.sizeGb ?? DEFAULT_SIZE_GB;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, zone, diskName);
      if (current?.status === "DELETING") {
        yield* waitDiskGone(env.project, zone, diskName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertDisks({
            project: env.project,
            zone,
            body: {
              name: diskName,
              sizeGb: String(sizeGb),
              type: diskTypeUrl(env.project, zone, diskType),
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
          yield* waitZoneOperation(env.project, zone, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitDiskReady(env.project, zone, diskName);
      }

      if (current === undefined) {
        return yield* new DiskNotResolved({ diskName, zone });
      }

      const observedSize = parseSizeGb(current.sizeGb);
      if (sizeGb > observedSize) {
        const resized = yield* compute.resizeDisks({
          project: env.project,
          zone,
          disk: diskName,
          body: { sizeGb: String(sizeGb) },
        });
        yield* waitZoneOperation(env.project, zone, resized);
        current = yield* waitDiskReady(env.project, zone, diskName);
      }

      if (current === undefined) {
        return yield* new DiskNotResolved({ diskName, zone });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsDisks({
          project: env.project,
          zone,
          resource: diskName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitZoneOperation(env.project, zone, labeled);
        current = yield* getByName(env.project, zone, diskName);
      }

      if (current === undefined) {
        return yield* new DiskNotResolved({ diskName, zone });
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
        const updated = yield* compute.updateDisks({
          project: env.project,
          zone,
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
        yield* waitZoneOperation(env.project, zone, updated);
        current = yield* getByName(env.project, zone, diskName);
      }

      if (current === undefined) {
        return yield* new DiskNotResolved({ diskName, zone });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* compute
        .deleteDisks({
          project: output.project,
          zone: output.zone,
          disk: output.diskName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (deleted !== undefined) {
        yield* waitZoneOperation(output.project, output.zone, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitDiskGone(output.project, output.zone, output.diskName);
    }),
  });
