import * as baremetalsolution from "@distilled.cloud/gcp/baremetalsolution_v2";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasOwnershipMarker,
  listVolumeSnapshots,
  normalizeLocation,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  volumeOf,
  waitUntilGone,
} from "./internal.ts";

export type VolumesSnapshotProps = {
  /**
   * Parent boot volume. Full name
   * `projects/{project}/locations/{location}/volumes/{volume}` or the
   * volume id (combined with `location`). Immutable — changing it
   * replaces the snapshot. Only boot volumes accept snapshots.
   */
  volume: string;
  /**
   * Region used when `volume` is a bare id. Immutable — changing it
   * replaces the snapshot. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Snapshot id (the `{snapshot}` segment of
   * `{volume}/snapshots/{snapshot}`). If omitted, the API assigns an id.
   * Immutable — changing it replaces the snapshot.
   */
  snapshotId?: string;
  /**
   * Human-readable description. Volume snapshots have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type VolumesSnapshot = Resource<
  "GCP.BareMetalSolution.VolumesSnapshot",
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
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Snapshot type (`AD_HOC` or `SCHEDULED`). */
    type: string | undefined;
    /** Backend-generated identifier. */
    id: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Bare Metal Solution boot-volume snapshot — a point-in-time copy of a
 * BMS boot volume.
 *
 * Snapshots have no labels field, so Alchemy stamps ownership into a
 * `[alchemy …]` description prefix for `list` / nuke. The API does not
 * expose an update method; description is set at create time. Changing
 * `snapshotId`, `volume`, or `location` replaces the snapshot.
 *
 * Creating a snapshot requires an existing boot volume in a Bare Metal
 * Solution environment. Non-boot volumes and unentitled accounts are
 * rejected by the API (`ServiceDisabled` when the API is off).
 *
 * ### Creating a Volume Snapshot
 * **Example:** Generated name
 * ```typescript
 * const snap = yield* GCP.BareMetalSolution.VolumesSnapshot("Nightly", {
 *   volume: volume.name,
 * });
 * ```
 *
 * **Example:** Description
 * ```typescript
 * const snap = yield* GCP.BareMetalSolution.VolumesSnapshot("Nightly", {
 *   volume: volume.name,
 *   description: "nightly boot snapshot",
 * });
 * ```
 *
 * @resource
 * @category BareMetalSolution
 */
export const VolumesSnapshot = Resource<VolumesSnapshot>(
  "GCP.BareMetalSolution.VolumesSnapshot",
);

const resourceName = (volume: string, snapshotId: string) =>
  `${volume}/snapshots/${snapshotId}`;

const toAttrs = (
  snapshot: baremetalsolution.VolumeSnapshot,
  project: string,
  region: string,
) => {
  const name = snapshot.name ?? "";
  const parsed = parseName(name, "snapshots", region);
  const ownership = parseOwnership(snapshot.description);
  return {
    name,
    snapshotId: parsed.id || snapshot.id || "",
    volume: snapshot.storageVolume || parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: ownership.text,
    type: snapshot.type,
    id: snapshot.id,
    createTime: snapshot.createTime,
  };
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0 || name.includes("//")) {
      return undefined;
    }
    return yield* baremetalsolution
      .getProjectsLocationsVolumesSnapshots({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

export const VolumesSnapshotProvider = () =>
  Provider.succeed(VolumesSnapshot, {
    stables: [
      "name",
      "snapshotId",
      "volume",
      "project",
      "location",
      "id",
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
      const volumeHint = olds?.volume ?? output?.volume ?? "";
      if (!output?.name && volumeHint.length === 0) return undefined;
      const volume = volumeOf(volumeHint, env.project, location);
      const snapshotId = olds?.snapshotId ?? output?.snapshotId;
      const name =
        output?.name ??
        (snapshotId !== undefined ? resourceName(volume, snapshotId) : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listVolumeSnapshots(env.project, env.region);
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const locationHint = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const volume = volumeOf(news.volume, env.project, locationHint);
      const snapshotId = news.snapshotId ?? output?.snapshotId;
      const name =
        output?.name ??
        (snapshotId !== undefined ? resourceName(volume, snapshotId) : "");
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* baremetalsolution
          .createProjectsLocationsVolumesSnapshots({
            parent: volume,
            body: {
              name: name.length > 0 ? name : undefined,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: name.length > 0 ? name : `${volume}/snapshots`,
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      yield* baremetalsolution
        .deleteProjectsLocationsVolumesSnapshots({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
