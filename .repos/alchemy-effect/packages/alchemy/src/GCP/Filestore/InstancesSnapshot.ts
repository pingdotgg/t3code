import * as file from "@distilled.cloud/gcp/file_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
  DEFAULT_ZONE,
  expandParent,
  fieldMask,
  hasAlchemyLabelMap,
  isDeletingState,
  lastSegment,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type InstancesSnapshotProps = {
  /**
   * Parent Filestore instance. Full name
   * `projects/{project}/locations/{location}/instances/{instance}` or
   * the instance id (combined with `location`). Immutable — changing it
   * replaces the snapshot.
   *
   * Snapshots require a Zonal, Regional, Enterprise, or High Scale SSD
   * instance. Basic HDD and Basic SSD do not support snapshots.
   */
  instance: string;
  /**
   * Location of the parent instance when `instance` is a bare id.
   * Ignored when `instance` is a full resource name. Immutable —
   * changing it replaces the snapshot. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Snapshot id (the `{snapshot}` segment of
   * `.../instances/{instance}/snapshots/{snapshot}`). If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Must start with a letter, be 1-63 characters, and end with a
   * letter or digit. Immutable — changing it replaces the snapshot.
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
  /**
   * Resource Manager tags (namespaced key to short value). Input-only
   * and immutable.
   */
  tags?: Record<string, string>;
};

export type InstancesSnapshot = Resource<
  "GCP.Filestore.InstancesSnapshot",
  InstancesSnapshotProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/instances/{instance}/snapshots/{snapshot}`. */
    name: string;
    /** Snapshot id (last path segment). */
    snapshotId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Project id. */
    project: string;
    /** Instance location (zone or region). */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Bytes needed to allocate a full copy of the snapshot. */
    filesystemUsedBytes: string | undefined;
    /** Server-reported state (`READY`, `CREATING`, `DELETING`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Filestore snapshot of an instance.
 *
 * Changing `snapshotId`, `instance`, or `location` replaces the
 * snapshot. Description and labels update in place.
 *
 * Snapshots are supported on Zonal, Regional, Enterprise, and High Scale
 * SSD instances. Basic HDD and Basic SSD reject snapshot create.
 *
 * ### Creating a Snapshot
 * **Example:** Generated name
 * ```typescript
 * const snap = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
 *   instance: nfs.name,
 * });
 * ```
 *
 * **Example:** Explicit id, description, and labels
 * ```typescript
 * const snap = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
 *   instance: nfs.name,
 *   snapshotId: "app-nightly",
 *   description: "nightly snapshot",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Snapshot
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const snap = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
 *   instance: nfs.name,
 *   description: "nightly snapshot v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category Filestore
 */
export const InstancesSnapshot = Resource<InstancesSnapshot>(
  "GCP.Filestore.InstancesSnapshot",
);

const resourceName = (instance: string, snapshotId: string) =>
  `${instance}/snapshots/${snapshotId}`;

const parseInstanceRef = (
  value: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const trimmed = value.trim();
  if (trimmed.includes("/")) {
    const parsed = parseName(trimmed, "instances", DEFAULT_ZONE);
    const location = normalizeLocation(parsed.location, DEFAULT_ZONE);
    return {
      project: parsed.project || fallbackProject,
      location,
      instanceId: parsed.id,
      instanceName: expandParent(
        parsed.id,
        parsed.project || fallbackProject,
        location,
        "instances",
      ),
    };
  }
  const location = normalizeLocation(fallbackLocation, DEFAULT_ZONE);
  const instanceId = lastSegment(trimmed);
  return {
    project: fallbackProject,
    location,
    instanceId,
    instanceName: expandParent(
      instanceId,
      fallbackProject,
      location,
      "instances",
    ),
  };
};

const toAttrs = (snapshot: file.Snapshot, project: string) => {
  const name = snapshot.name ?? "";
  const parsed = parseName(name, "snapshots", DEFAULT_ZONE);
  return {
    name,
    snapshotId: parsed.id,
    instance: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: snapshot.description,
    labels: userLabels(snapshot.labels),
    filesystemUsedBytes: snapshot.filesystemUsedBytes,
    state: snapshot.state,
    createTime: snapshot.createTime,
  };
};

const isPlaceholder = (snapshot: file.Snapshot) => {
  const name = snapshot.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith("/snapshots/-") ||
    name.endsWith("/snapshots/")
  );
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0 || name.includes("//")) return undefined;
    return yield* file
      .getProjectsLocationsInstancesSnapshots({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

const listViaInstances = (project: string) =>
  file.listProjectsLocationsInstances
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) => (instance.name ?? "").length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.flatMap((instances) =>
        Effect.forEach(
          instances,
          (instance) =>
            listLabeledPages(
              file.listProjectsLocationsInstancesSnapshots.pages({
                parent: instance.name!,
                pageSize: 1000,
              }),
              (page) => page.snapshots,
              (item) => item.labels,
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((groups) => groups.flat())),
      ),
    );

const listOwned = (project: string) =>
  file.listProjectsLocationsInstancesSnapshots
    .pages({
      parent: `projects/${project}/locations/-/instances/-`,
      pageSize: 1000,
      returnPartialSuccess: true,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.snapshots ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchIf(
        () => true,
        () => listViaInstances(project),
      ),
    );

export const InstancesSnapshotProvider = () =>
  Provider.succeed(InstancesSnapshot, {
    stables: [
      "name",
      "snapshotId",
      "instance",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous = parseInstanceRef(
        olds?.instance ?? output?.instance ?? "",
        env.project,
        olds?.location ?? output?.location ?? DEFAULT_ZONE,
      );
      const next = parseInstanceRef(
        news.instance,
        env.project,
        news.location ??
          olds?.location ??
          output?.location ??
          previous.location,
      );
      return replaceOnIdentity({
        previousId: olds?.snapshotId ?? output?.snapshotId,
        nextId: news.snapshotId ?? olds?.snapshotId ?? output?.snapshotId,
        previousLocation: previous.location,
        nextLocation: next.location,
        previousParent: previous.instanceName,
        nextParent: next.instanceName,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = parseInstanceRef(
        olds?.instance ?? output?.instance ?? "",
        env.project,
        olds?.location ?? output?.location ?? DEFAULT_ZONE,
      );
      const snapshotId = yield* toPhysicalId(
        id,
        olds?.snapshotId,
        output?.snapshotId,
        "snapshot",
      );
      const name =
        output?.name ?? resourceName(instance.instanceName, snapshotId);
      const existing = yield* getByName(name);
      if (existing === undefined || isPlaceholder(existing)) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items
          .filter(
            (item) => !isPlaceholder(item) && hasAlchemyLabelMap(item.labels),
          )
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = parseInstanceRef(
        news.instance,
        env.project,
        news.location ?? output?.location ?? DEFAULT_ZONE,
      );
      const snapshotId = yield* toPhysicalId(
        id,
        news.snapshotId,
        output?.snapshotId,
        "snapshot",
      );
      const name = resourceName(instance.instanceName, snapshotId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && isDeletingState(current.state)) {
        yield* waitUntilGone(
          getByName(current.name ?? name),
          current.name ?? name,
        );
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* file
          .createProjectsLocationsInstancesSnapshots({
            parent: instance.instanceName,
            snapshotId,
            body: {
              description: news.description,
              labels: desiredLabels,
              tags: news.tags,
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
      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
      ]);

      if (mask.length > 0) {
        const operation = yield* file.patchProjectsLocationsInstancesSnapshots({
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
        if (current === undefined) {
          return yield* new ResourceNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* file
        .deleteProjectsLocationsInstancesSnapshots({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
