import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
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
  fieldMask,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GroupProps = {
  /**
   * Group id (the `{group}` segment of
   * `projects/{project}/locations/{location}/groups/{group}`). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it replaces
   * the group.
   */
  groupId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * group. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Free-text description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Group = Resource<
  "GCP.MigrationCenter.Group",
  GroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Group id (last path segment). */
    groupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Free-text description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center asset group used to bundle related assets and
 * generate reports.
 *
 * Changing `groupId` or `location` replaces the group. Display name,
 * description, and labels update in place.
 *
 * ### Creating a Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.MigrationCenter.Group("Workloads", {
 *   displayName: "workloads",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const group = yield* GCP.MigrationCenter.Group("Workloads", {
 *   groupId: "app-workloads",
 *   description: "production vms",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const Group = Resource<Group>("GCP.MigrationCenter.Group");

const resourceName = (project: string, location: string, groupId: string) =>
  `${locationParent(project, location)}/groups/${groupId}`;

const toAttrs = (group: mc.Group, project: string, region: string) => {
  const name = group.name ?? "";
  const parsed = parseName(name, "groups", region);
  return {
    name,
    groupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: group.displayName,
    description: group.description,
    labels: userLabels(group.labels),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsGroups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsGroups
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsGroups
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([] as mc.Group[])),
          ),
      ),
    );

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["name", "groupId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.groupId ?? output?.groupId,
        nextId: news.groupId ?? olds?.groupId ?? output?.groupId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const groupId = yield* toPhysicalId(
        id,
        olds?.groupId,
        output?.groupId,
        "group",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, groupId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const groupId = yield* toPhysicalId(
        id,
        news.groupId,
        output?.groupId,
        "group",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, groupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? groupId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsGroups({
            parent: locationParent(env.project, location),
            groupId,
            body: {
              displayName,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        descriptionChanged && "description",
      ]);

      if (mask.length > 0) {
        const operation = yield* mc.patchProjectsLocationsGroups({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description: news.description,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsGroups({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
