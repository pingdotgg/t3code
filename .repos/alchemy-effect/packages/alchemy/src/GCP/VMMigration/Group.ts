import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  fieldMask,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GroupMigrationTargetType =
  | vm.GroupMigrationTargetTypeEnum
  | (string & {});

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
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Free-text description. Groups have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
  /**
   * Target type of this group. Immutable — changing it replaces the
   * group.
   * @default "MIGRATION_TARGET_TYPE_GCE"
   */
  migrationTargetType?: GroupMigrationTargetType;
};

export type Group = Resource<
  "GCP.VMMigration.Group",
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
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Target type of this group. */
    migrationTargetType: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration group that bundles migrating VMs so they can be
 * managed together.
 *
 * Groups have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. `groupId`, `location`, and
 * `migrationTargetType` are immutable. Display name and description
 * update in place.
 *
 * ### Creating a Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.VMMigration.Group("Workloads", {
 *   displayName: "workloads",
 *   description: "production vms",
 * });
 * ```
 *
 * **Example:** Disk-target group
 * ```typescript
 * const group = yield* GCP.VMMigration.Group("Disks", {
 *   groupId: "disk-workloads",
 *   migrationTargetType: "MIGRATION_TARGET_TYPE_DISKS",
 * });
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const Group = Resource<Group>("GCP.VMMigration.Group");

const DEFAULT_TARGET: GroupMigrationTargetType = "MIGRATION_TARGET_TYPE_GCE";

const resourceName = (project: string, location: string, groupId: string) =>
  `${locationParent(project, location)}/groups/${groupId}`;

const toAttrs = (group: vm.Group, project: string, region: string) => {
  const name = group.name ?? "";
  const parsed = parseName(name, "groups", region);
  const ownership = parseOwnership(group.description);
  return {
    name,
    groupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: group.displayName,
    description: ownership.text,
    migrationTargetType: group.migrationTargetType,
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsGroups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  vm.listProjectsLocationsGroups
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        vm.listProjectsLocationsGroups
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([] as vm.Group[])),
          ),
      ),
    );

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["name", "groupId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType =
        olds?.migrationTargetType ??
        output?.migrationTargetType ??
        DEFAULT_TARGET;
      const nextType = news.migrationTargetType ?? previousType;
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
        extra: previousType !== nextType,
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
      return (yield* ownedByAlchemy(id, existing.description))
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
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? groupId;
      const migrationTargetType = news.migrationTargetType ?? DEFAULT_TARGET;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsGroups({
            parent: locationParent(env.project, location),
            groupId,
            body: {
              displayName,
              description,
              migrationTargetType,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const descriptionChanged = (current.description ?? "") !== description;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const mask = fieldMask([
        descriptionChanged && "description",
        displayNameChanged && "displayName",
      ]);

      if (mask.length > 0) {
        const operation = yield* vm.patchProjectsLocationsGroups({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description,
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
      const operation = yield* vm
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
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
