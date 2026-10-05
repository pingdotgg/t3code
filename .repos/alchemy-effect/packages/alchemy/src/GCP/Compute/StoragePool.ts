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

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_TYPE = "hyperdisk-balanced";
const MAX_NAME_LENGTH = 63;

export type StoragePoolCapacityProvisioningType =
  | compute.StoragePoolCapacityProvisioningTypeEnum
  | (string & {});
export type StoragePoolPerformanceProvisioningType =
  | compute.StoragePoolPerformanceProvisioningTypeEnum
  | (string & {});

export type StoragePoolProps = {
  /**
   * Storage pool name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the pool.
   */
  storagePoolName?: string;
  /**
   * Zone the pool lives in (e.g. `us-central1-a`). Immutable — changing it
   * replaces the pool.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Storage pool type (`hyperdisk-balanced`, `hyperdisk-throughput`,
   * `hyperdisk-extreme`, …). Immutable — changing it replaces the pool.
   * @default "hyperdisk-balanced"
   */
  storagePoolType?: string;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Provisioned pool capacity in GiB. Mutable in place. Hyperdisk Balanced
   * pools typically require at least 10240 GiB.
   */
  poolProvisionedCapacityGb?: number | string;
  /**
   * Provisioned IOPS (hyperdisk-balanced). Mutable in place.
   */
  poolProvisionedIops?: number | string;
  /**
   * Provisioned throughput in MiB/s (hyperdisk-balanced /
   * hyperdisk-throughput). Mutable in place.
   */
  poolProvisionedThroughput?: number | string;
  /**
   * Capacity provisioning type. Immutable — changing it replaces the pool.
   */
  capacityProvisioningType?: StoragePoolCapacityProvisioningType;
  /**
   * Performance provisioning type. Immutable — changing it replaces the
   * pool.
   */
  performanceProvisioningType?: StoragePoolPerformanceProvisioningType;
};

export type StoragePool = Resource<
  "GCP.Compute.StoragePool",
  StoragePoolProps,
  {
    /** Storage pool name. */
    storagePoolName: string;
    /** Server-assigned numeric id. */
    storagePoolId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
    /** Storage pool type short name. */
    storagePoolType: string | undefined;
    /** Optional description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Provisioned capacity in GiB. */
    poolProvisionedCapacityGb: string | undefined;
    /** Provisioned IOPS. */
    poolProvisionedIops: string | undefined;
    /** Provisioned throughput in MiB/s. */
    poolProvisionedThroughput: string | undefined;
    /** Capacity provisioning type. */
    capacityProvisioningType: string | undefined;
    /** Performance provisioning type. */
    performanceProvisioningType: string | undefined;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine Hyperdisk storage pool.
 *
 * Storage pools pre-purchase Hyperdisk capacity, IOPS, and throughput.
 * Changing `zone`, `storagePoolType`, `capacityProvisioningType`, or
 * `performanceProvisioningType` replaces the pool. Capacity, IOPS,
 * throughput, labels, and description update in place.
 *
 * ### Creating a Storage Pool
 * **Example:** Hyperdisk Balanced pool
 * ```typescript
 * const pool = yield* GCP.Compute.StoragePool("disks", {
 *   storagePoolType: "hyperdisk-balanced",
 *   poolProvisionedCapacityGb: 10240,
 *   poolProvisionedIops: 10000,
 *   poolProvisionedThroughput: 1024,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Named pool in a specific zone
 * ```typescript
 * const pool = yield* GCP.Compute.StoragePool("disks", {
 *   storagePoolName: "app-hyperdisk",
 *   zone: "us-central1-a",
 *   description: "shared hyperdisk capacity",
 *   poolProvisionedCapacityGb: 10240,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const StoragePool = Resource<StoragePool>("GCP.Compute.StoragePool");

export class StoragePoolNotResolved extends Data.TaggedError(
  "GCP.Compute.StoragePoolNotResolved",
)<{
  storagePoolName: string;
  zone: string;
}> {}

export class StoragePoolNotReady extends Data.TaggedError(
  "GCP.Compute.StoragePoolNotReady",
)<{
  storagePoolName: string;
  status: string;
}> {}

export class StoragePoolFailed extends Data.TaggedError(
  "GCP.Compute.StoragePoolFailed",
)<{
  storagePoolName: string;
  status: string;
}> {}

export class StoragePoolStillExists extends Data.TaggedError(
  "GCP.Compute.StoragePoolStillExists",
)<{
  storagePoolName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeZone = (zone: string | undefined) =>
  lastSegment(zone ?? DEFAULT_ZONE).toLowerCase();

const asString = (value: number | string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return String(value);
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
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const poolTypeUrl = (project: string, zone: string, type: string) =>
  type.includes("/")
    ? type
    : `projects/${project}/zones/${zone}/storagePoolTypes/${type}`;

const toAttrs = (
  pool: compute.StoragePool,
  project: string,
): StoragePool["Attributes"] => ({
  storagePoolName: pool.name ?? pool.id ?? "",
  storagePoolId: pool.id,
  project,
  zone: normalizeZone(pool.zone),
  storagePoolType: lastSegment(pool.storagePoolType) || undefined,
  description: pool.description,
  labels: userLabels(pool.labels),
  poolProvisionedCapacityGb: pool.poolProvisionedCapacityGb,
  poolProvisionedIops: pool.poolProvisionedIops,
  poolProvisionedThroughput: pool.poolProvisionedThroughput,
  capacityProvisioningType: pool.capacityProvisioningType,
  performanceProvisioningType: pool.performanceProvisioningType,
  state: pool.state,
  selfLink: pool.selfLink,
  creationTimestamp: pool.creationTimestamp,
});

const getByName = (project: string, zone: string, storagePool: string) =>
  compute
    .getStoragePools({ project, zone, storagePool })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPoolReady = (
  project: string,
  zone: string,
  storagePoolName: string,
) =>
  getByName(project, zone, storagePoolName).pipe(
    Effect.flatMap((pool) =>
      pool?.state === "FAILED"
        ? Effect.fail(
            new StoragePoolFailed({
              storagePoolName,
              status: "FAILED",
            }),
          )
        : Effect.succeed(pool),
    ),
    Effect.filterOrFail(
      (pool): pool is compute.StoragePool =>
        pool !== undefined && pool.state === "READY",
      (pool) =>
        new StoragePoolNotReady({
          storagePoolName,
          status: pool?.state ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.StoragePoolNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitPoolGone = (project: string, zone: string, storagePoolName: string) =>
  getByName(project, zone, storagePoolName).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(
            new StoragePoolStillExists({
              storagePoolName,
              status: pool.state ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof StoragePoolStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const StoragePoolProvider = () =>
  Provider.succeed(StoragePool, {
    stables: [
      "storagePoolName",
      "storagePoolId",
      "project",
      "zone",
      "storagePoolType",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.storagePoolName ?? output?.storagePoolName;
      const nextName = news.storagePoolName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousZone = normalizeZone(olds?.zone ?? output?.zone);
      const nextZone = normalizeZone(news.zone ?? output?.zone);
      const previousType =
        lastSegment(olds?.storagePoolType) ||
        lastSegment(output?.storagePoolType) ||
        DEFAULT_TYPE;
      const nextType = lastSegment(news.storagePoolType) || DEFAULT_TYPE;
      const previousCapacityType =
        olds?.capacityProvisioningType ?? output?.capacityProvisioningType;
      const nextCapacityType = news.capacityProvisioningType;
      const previousPerfType =
        olds?.performanceProvisioningType ??
        output?.performanceProvisioningType;
      const nextPerfType = news.performanceProvisioningType;

      const typeChanged = previousType !== nextType;
      const capacityTypeChanged =
        previousCapacityType !== undefined &&
        nextCapacityType !== undefined &&
        previousCapacityType !== nextCapacityType;
      const perfTypeChanged =
        previousPerfType !== undefined &&
        nextPerfType !== undefined &&
        previousPerfType !== nextPerfType;

      if (
        nameChanged ||
        previousZone !== nextZone ||
        typeChanged ||
        capacityTypeChanged ||
        perfTypeChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName === previousName &&
            previousZone === nextZone,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const storagePoolName = yield* toName(
        id,
        olds?.storagePoolName,
        output?.storagePoolName,
      );
      const zone = normalizeZone(olds?.zone ?? output?.zone);
      const existing = yield* getByName(env.project, zone, storagePoolName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListStoragePools
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.storagePools ?? [])
              .filter((pool) =>
                Object.keys(pool.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((pool) => toAttrs(pool, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const storagePoolName = yield* toName(
        id,
        news.storagePoolName,
        output?.storagePoolName,
      );
      const zone = normalizeZone(news.zone ?? output?.zone);
      const storagePoolType = lastSegment(news.storagePoolType) || DEFAULT_TYPE;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const capacity = asString(news.poolProvisionedCapacityGb);
      const iops = asString(news.poolProvisionedIops);
      const throughput = asString(news.poolProvisionedThroughput);

      let current = yield* getByName(env.project, zone, storagePoolName);
      if (current?.state === "DELETING") {
        yield* waitPoolGone(env.project, zone, storagePoolName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertStoragePools({
            project: env.project,
            zone,
            body: {
              name: storagePoolName,
              description: news.description,
              labels: desiredLabels,
              storagePoolType: poolTypeUrl(env.project, zone, storagePoolType),
              poolProvisionedCapacityGb: capacity,
              poolProvisionedIops: iops,
              poolProvisionedThroughput: throughput,
              capacityProvisioningType: news.capacityProvisioningType,
              performanceProvisioningType: news.performanceProvisioningType,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitZoneOperation(env.project, zone, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitPoolReady(env.project, zone, storagePoolName);
      }

      if (current === undefined) {
        return yield* new StoragePoolNotResolved({
          storagePoolName,
          zone,
        });
      }

      if (current.state === "CREATING") {
        current = yield* waitPoolReady(env.project, zone, storagePoolName);
      }

      if (current === undefined) {
        return yield* new StoragePoolNotResolved({
          storagePoolName,
          zone,
        });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const capacityChanged =
        capacity !== undefined &&
        capacity !== (current.poolProvisionedCapacityGb ?? "");
      const iopsChanged =
        iops !== undefined && iops !== (current.poolProvisionedIops ?? "");
      const throughputChanged =
        throughput !== undefined &&
        throughput !== (current.poolProvisionedThroughput ?? "");
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (
        descriptionChanged ||
        capacityChanged ||
        iopsChanged ||
        throughputChanged ||
        labelsChanged
      ) {
        const patched = yield* compute.updateStoragePools({
          project: env.project,
          zone,
          storagePool: storagePoolName,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            capacityChanged ? "poolProvisionedCapacityGb" : undefined,
            iopsChanged ? "poolProvisionedIops" : undefined,
            throughputChanged ? "poolProvisionedThroughput" : undefined,
            labelsChanged ? "labels" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            description: news.description,
            poolProvisionedCapacityGb: capacity,
            poolProvisionedIops: iops,
            poolProvisionedThroughput: throughput,
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitZoneOperation(env.project, zone, patched);
        current =
          (yield* getByName(env.project, zone, storagePoolName)) ??
          (yield* waitPoolReady(env.project, zone, storagePoolName));
      }

      if (current === undefined) {
        return yield* new StoragePoolNotResolved({
          storagePoolName,
          zone,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const zone = normalizeZone(output.zone);
      const deleted = yield* compute
        .deleteStoragePools({
          project,
          zone,
          storagePool: output.storagePoolName,
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
        yield* waitZoneOperation(project, zone, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitPoolGone(project, zone, output.storagePoolName);
    }),
  });
