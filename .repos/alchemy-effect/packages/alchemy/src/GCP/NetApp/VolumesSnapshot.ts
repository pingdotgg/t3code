import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  volumeOf,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type VolumesSnapshotProps = {
  /**
   * Parent volume. Full name
   * `projects/{project}/locations/{location}/volumes/{volume}` or the
   * volume id (combined with `location`). Immutable — changing it
   * replaces the snapshot.
   */
  volume: string;
  /**
   * Region used when `volume` is a bare id. Immutable — changing it
   * replaces the snapshot. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Snapshot id (the `{snapshot}` segment of
   * `.../volumes/{volume}/snapshots/{snapshot}`). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the snapshot.
   */
  snapshotId?: string;
  /**
   * Human-readable description (2048 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type VolumesSnapshot = Resource<
  "GCP.NetApp.VolumesSnapshot",
  VolumesSnapshotProps,
  {
    /** Full resource name. */
    name: string;
    /** Snapshot id (last path segment). */
    snapshotId: string;
    /** Parent volume resource name. */
    volume: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Storage used by unique snapshot blocks, in bytes. */
    usedBytes: number | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-reported state details. */
    stateDetails: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes snapshot — a point-in-time copy of a volume.
 *
 * Changing `snapshotId`, `volume`, or `location` replaces the snapshot.
 * Description and labels update in place.
 *
 * ### Creating a Snapshot
 * **Example:** Generated name
 * ```typescript
 * const snap = yield* GCP.NetApp.VolumesSnapshot("Nightly", {
 *   volume: volume.name,
 * });
 * ```
 *
 * **Example:** Explicit id, description, and labels
 * ```typescript
 * const snap = yield* GCP.NetApp.VolumesSnapshot("Nightly", {
 *   volume: volume.name,
 *   snapshotId: "app-nightly",
 *   description: "nightly snapshot",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Snapshot
 * **Example:** Description and labels
 * ```typescript
 * const snap = yield* GCP.NetApp.VolumesSnapshot("Nightly", {
 *   volume: volume.name,
 *   description: "nightly snapshot v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const VolumesSnapshot = Resource<VolumesSnapshot>(
  "GCP.NetApp.VolumesSnapshot",
);

const resourceName = (volume: string, snapshotId: string) =>
  `${volume}/snapshots/${snapshotId}`;

const toAttrs = (
  snapshot: netapp.Snapshot,
  project: string,
  region: string,
) => {
  const name = snapshot.name ?? "";
  const parsed = parseName(name, "snapshots", region);
  return {
    name,
    snapshotId: parsed.id,
    volume: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: snapshot.description,
    labels: userLabels(snapshot.labels),
    usedBytes: snapshot.usedBytes,
    state: snapshot.state,
    stateDetails: snapshot.stateDetails,
    createTime: snapshot.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : netapp
        .getProjectsLocationsVolumesSnapshots({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "volumes/-", (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsVolumesSnapshots.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.snapshots,
      (item) => item.labels,
    ),
  );

export const VolumesSnapshotProvider = () =>
  Provider.succeed(VolumesSnapshot, {
    stables: [
      "name",
      "snapshotId",
      "volume",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousVolume = volumeOf(
        olds?.volume ?? output?.volume ?? "",
        env.project,
        previousLocation,
      );
      const nextVolume = volumeOf(
        news.volume ?? olds?.volume ?? output?.volume ?? "",
        env.project,
        nextLocation,
      );
      return replaceOnIdentity({
        previousId: olds?.snapshotId ?? output?.snapshotId,
        nextId: news.snapshotId ?? olds?.snapshotId ?? output?.snapshotId,
        previousLocation,
        nextLocation,
        previousParent: previousVolume,
        nextParent: nextVolume,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const volume = volumeOf(
        olds?.volume ?? output?.volume ?? "",
        env.project,
        location,
      );
      const snapshotId = yield* toPhysicalId(
        id,
        olds?.snapshotId,
        output?.snapshotId,
        "snapshot",
      );
      const name = output?.name ?? resourceName(volume, snapshotId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const locationHint = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const volume = volumeOf(news.volume, env.project, locationHint);
      const snapshotId = yield* toPhysicalId(
        id,
        news.snapshotId,
        output?.snapshotId,
        "snapshot",
      );
      const name = output?.name ?? resourceName(volume, snapshotId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsVolumesSnapshots({
            parent: volume,
            snapshotId,
            body: {
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const mask = fieldMask([
        labelsChanged && "labels",
        descriptionChanged && "description",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsVolumesSnapshots({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* netapp
        .deleteProjectsLocationsVolumesSnapshots({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
