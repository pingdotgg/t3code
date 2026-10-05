import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
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

const DEFAULT_ZONE = "us-central1-a";

export type InstantSnapshotProps = {
  /**
   * Instant snapshot name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the snapshot.
   */
  instantSnapshotName?: string;
  /**
   * Zone of the snapshot and its source disk (e.g. `us-central1-a`).
   * Immutable — changing it replaces the snapshot. Inferred from
   * `sourceDisk` when omitted.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Source disk URL or relative path
   * (`projects/{project}/zones/{zone}/disks/{disk}`). Immutable —
   * changing it replaces the snapshot.
   */
  sourceDisk: string;
  /**
   * Optional description. Immutable — changing it replaces the snapshot.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `instantSnapshots.setLabels`.
   */
  labels?: Record<string, string>;
};

export type InstantSnapshot = Resource<
  "GCP.Compute.InstantSnapshot",
  InstantSnapshotProps,
  {
    /** Instant snapshot name. */
    instantSnapshotName: string;
    /** Server-assigned numeric id. */
    instantSnapshotId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
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
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Architecture (`X86_64` or `ARM64`). */
    architecture: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine instant snapshot.
 *
 * Instant snapshots capture a disk's point-in-time state in the same zone
 * (Hyperdisk and some persistent-disk types). Name, zone, source disk, and
 * description are immutable — changing them replaces the snapshot. Labels
 * update in place via `instantSnapshots.setLabels`.
 *
 * ### Creating an Instant Snapshot
 * **Example:** Snapshot of a disk
 * ```typescript
 * const disk = yield* GCP.Compute.Disk("data", {
 *   zone: "us-central1-a",
 *   type: "pd-balanced",
 *   sizeGb: 10,
 * });
 * const snap = yield* GCP.Compute.InstantSnapshot("checkpoint", {
 *   sourceDisk: disk.selfLink,
 *   zone: disk.zone,
 * });
 * ```
 *
 * **Example:** Named snapshot with labels
 * ```typescript
 * const snap = yield* GCP.Compute.InstantSnapshot("checkpoint", {
 *   instantSnapshotName: "app-data-now",
 *   zone: "us-central1-a",
 *   sourceDisk: "zones/us-central1-a/disks/app-data",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstantSnapshot = Resource<InstantSnapshot>(
  "GCP.Compute.InstantSnapshot",
);

export class InstantSnapshotNotResolved extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotNotResolved",
)<{
  instantSnapshotName: string;
  zone: string;
}> {}

export class InstantSnapshotNotReady extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotNotReady",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

export class InstantSnapshotFailed extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotFailed",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

export class InstantSnapshotStillExists extends Data.TaggedError(
  "GCP.Compute.InstantSnapshotStillExists",
)<{
  instantSnapshotName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const zoneFromDisk = (sourceDisk: string | undefined): string | undefined => {
  if (!sourceDisk) return undefined;
  const match = sourceDisk.match(/\/zones\/([^/]+)\//);
  return match?.[1];
};

const canonicalizeSource = (source: string | undefined): string => {
  if (source === undefined || source.length === 0) return "";
  return lastSegment(source) ?? source;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `i${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "instantsnapshot";
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

const toAttrs = (
  snapshot: compute.InstantSnapshot,
  project: string,
): InstantSnapshot["Attributes"] => ({
  instantSnapshotName: snapshot.name ?? snapshot.id ?? "",
  instantSnapshotId: snapshot.id,
  project,
  zone: lastSegment(snapshot.zone) ?? DEFAULT_ZONE,
  sourceDisk: snapshot.sourceDisk,
  sourceDiskId: snapshot.sourceDiskId,
  description: snapshot.description,
  status: snapshot.status,
  diskSizeGb: snapshot.diskSizeGb,
  labels: userLabels(snapshot.labels),
  selfLink: snapshot.selfLink,
  creationTimestamp: snapshot.creationTimestamp,
  architecture: snapshot.architecture,
});

const getByName = (project: string, zone: string, instantSnapshot: string) =>
  compute
    .getInstantSnapshots({ project, zone, instantSnapshot })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitReady = (project: string, zone: string, name: string) =>
  getByName(project, zone, name).pipe(
    Effect.flatMap((snapshot) =>
      snapshot?.status === "FAILED"
        ? Effect.fail(
            new InstantSnapshotFailed({
              instantSnapshotName: name,
              status: "FAILED",
            }),
          )
        : Effect.succeed(snapshot),
    ),
    Effect.filterOrFail(
      (snapshot): snapshot is compute.InstantSnapshot =>
        snapshot !== undefined && snapshot.status === "READY",
      (snapshot) =>
        new InstantSnapshotNotReady({
          instantSnapshotName: name,
          status: snapshot?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InstantSnapshotNotReady",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitGone = (project: string, zone: string, name: string) =>
  getByName(project, zone, name).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.void
        : Effect.fail(
            new InstantSnapshotStillExists({
              instantSnapshotName: name,
              status: snapshot.status ?? "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InstantSnapshotStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const InstantSnapshotProvider = () =>
  Provider.succeed(InstantSnapshot, {
    stables: [
      "instantSnapshotName",
      "instantSnapshotId",
      "project",
      "zone",
      "sourceDisk",
      "sourceDiskId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.instantSnapshotName ?? output?.instantSnapshotName;
      const nextName = news.instantSnapshotName ?? previousName;
      const previousZone =
        lastSegment(olds?.zone) ?? lastSegment(output?.zone) ?? DEFAULT_ZONE;
      const nextZone =
        lastSegment(news.zone) ?? zoneFromDisk(news.sourceDisk) ?? previousZone;
      const previousDisk = canonicalizeSource(
        olds?.sourceDisk ?? output?.sourceDisk,
      );
      const nextDisk = canonicalizeSource(news.sourceDisk);
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";

      const replace =
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousZone !== nextZone ||
        (nextDisk.length > 0 &&
          previousDisk.length > 0 &&
          previousDisk !== nextDisk) ||
        previousDescription !== nextDescription;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          previousName === nextName &&
          previousZone === nextZone,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instantSnapshotName = yield* toName(
        id,
        olds?.instantSnapshotName,
        output?.instantSnapshotName,
      );
      const zone =
        lastSegment(olds?.zone) ??
        lastSegment(output?.zone) ??
        zoneFromDisk(olds?.sourceDisk ?? output?.sourceDisk) ??
        DEFAULT_ZONE;
      const existing = yield* getByName(env.project, zone, instantSnapshotName);
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
              .filter((item) =>
                Object.keys(item.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((item) => toAttrs(item, env.project)),
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
      const zone =
        lastSegment(news.zone) ??
        lastSegment(output?.zone) ??
        zoneFromDisk(news.sourceDisk) ??
        DEFAULT_ZONE;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, zone, instantSnapshotName);
      if (current?.status === "DELETING") {
        yield* waitGone(env.project, zone, instantSnapshotName);
        current = undefined;
      }

      if (current === undefined) {
        // "The previous instant snapshot is too recent" — one instant snapshot
        // per disk every 30 seconds.
        const tooRecent = (error: { readonly _tag: string }) =>
          error instanceof OperationFailed &&
          error.reason === "UNSUPPORTED_OPERATION";
        yield* compute
          .insertInstantSnapshots({
            project: env.project,
            zone,
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
                : waitZoneOperation(env.project, zone, inserted, {
                    ignore: ["RESOURCE_ALREADY_EXISTS"],
                  }),
            ),
            Effect.retry({
              while: tooRecent,
              times: 3,
              schedule: Schedule.spaced("30 seconds"),
            }),
          );
        current = yield* waitReady(env.project, zone, instantSnapshotName);
      }

      if (current === undefined) {
        return yield* new InstantSnapshotNotResolved({
          instantSnapshotName,
          zone,
        });
      }

      if (current.status !== "READY") {
        current = yield* waitReady(env.project, zone, instantSnapshotName);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        const labeled = yield* compute.setLabelsInstantSnapshots({
          project: env.project,
          zone,
          resource: instantSnapshotName,
          body: {
            labels: desiredLabels,
            labelFingerprint: current.labelFingerprint,
          },
        });
        yield* waitZoneOperation(env.project, zone, labeled);
        current = yield* getByName(env.project, zone, instantSnapshotName);
      }

      if (current === undefined) {
        return yield* new InstantSnapshotNotResolved({
          instantSnapshotName,
          zone,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const zone = lastSegment(output.zone) ?? DEFAULT_ZONE;
      const operation = yield* compute
        .deleteInstantSnapshots({
          project,
          zone,
          instantSnapshot: output.instantSnapshotName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitZoneOperation(project, zone, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      yield* waitGone(project, zone, output.instantSnapshotName);
    }),
  });
