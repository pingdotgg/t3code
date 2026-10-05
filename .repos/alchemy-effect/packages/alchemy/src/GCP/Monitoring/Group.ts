import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDisplayName,
  hasOwnershipMarker,
  lastSegment,
  parentOf,
  parseMarker,
} from "./ownership.ts";

const MAX_DISPLAY_NAME_LENGTH = 512;

export type GroupProps = {
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id. Groups have no labels field,
   * so Alchemy stamps ownership into this value for `list` / nuke.
   */
  displayName?: string;
  /**
   * Monitoring filter matching member resources (for example
   * `resource.metadata.region="us-central1"`).
   */
  filter: string;
  /**
   * Parent group resource name
   * (`projects/{project}/groups/{group}`). Empty means a root group.
   */
  parentName?: string;
  /**
   * When true, members are treated as a cluster for extra analysis.
   * @default false
   */
  isCluster?: boolean;
};

export type Group = Resource<
  "GCP.Monitoring.Group",
  GroupProps,
  {
    /** Full resource name `projects/{project}/groups/{group}`. */
    name: string;
    /** Server-assigned group id (last path segment). */
    groupId: string;
    /** Project id. */
    project: string;
    /** Human-readable display name (ownership marker stripped). */
    displayName: string | undefined;
    /** Membership filter. */
    filter: string;
    /** Parent group resource name, or empty for a root group. */
    parentName: string;
    /** Whether members are treated as a cluster. */
    isCluster: boolean;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring group — a dynamic collection of monitored
 * resources selected by a filter.
 *
 * Group ids are assigned by the API. Groups have no labels field, so
 * Alchemy stamps ownership into `displayName` (`[alchemy
 * alchemy-stack=… alchemy-stage=… alchemy-id=…]`) so `list` /
 * `pnpm nuke:gcp` can find them. Display name, filter, parent, and
 * cluster flag update in place.
 *
 * ### Creating a Group
 * **Example:** Root group of GCE instances in a region
 * ```typescript
 * const group = yield* GCP.Monitoring.Group("Prod", {
 *   displayName: "production instances",
 *   filter: 'resource.metadata.region="us-central1"',
 * });
 * ```
 *
 * **Example:** Nested group
 * ```typescript
 * const parent = yield* GCP.Monitoring.Group("Prod", {
 *   filter: 'resource.metadata.region="us-central1"',
 * });
 * const child = yield* GCP.Monitoring.Group("Workers", {
 *   filter: 'resource.metadata.tag="worker"',
 *   parentName: parent.name,
 * });
 * ```
 *
 * ### Updating a Group
 * **Example:** Retarget the filter and mark as a cluster
 * ```typescript
 * const group = yield* GCP.Monitoring.Group("Prod", {
 *   displayName: "production instances",
 *   filter: 'resource.metadata.region="us-east1"',
 *   isCluster: true,
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const Group = Resource<Group>("GCP.Monitoring.Group");

export class GroupNotResolved extends Data.TaggedError(
  "GCP.Monitoring.GroupNotResolved",
)<{
  name: string;
}> {}

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_DISPLAY_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const toAttrs = (group: monitoring.Group, project: string) => {
  const name = group.name ?? "";
  const parsed = parseMarker(group.displayName);
  return {
    name,
    groupId: lastSegment(name),
    project,
    displayName: parsed.rest,
    filter: group.filter ?? "",
    parentName: group.parentName ?? "",
    isCluster: group.isCluster === true,
  };
};

const getByName = (name: string) =>
  monitoring
    .getProjectsGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPages = (project: string) =>
  monitoring.listProjectsGroups
    .pages({
      name: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.group ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const groups = yield* listPages(project);
    return groups
      .filter((group) => hasOwnershipMarker(group.displayName))
      .map((group) => toAttrs(group, project));
  });

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const groups = yield* listPages(project);
    for (const group of groups) {
      if (yield* hasAlchemyLabels(id, parseMarker(group.displayName).labels)) {
        return group;
      }
    }
    return undefined;
  });

const observe = (project: string, id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findOwned(project, id);
  });

/**
 * Monitoring answers 409 "Too many concurrent edits to the project
 * configuration" while another write to the project's monitoring config is
 * in flight; it clears within seconds.
 */
const retryConcurrentEdits = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.exponential("500 millis"),
    }),
  );

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["name", "groupId", "project"],

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(env.project, id, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseMarker(existing.displayName).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const ownership = yield* createInternalLabels(id);
      const encodedDisplayName = encodeDisplayName(ownership, displayName);
      const desiredParent = news.parentName ?? "";
      const desiredCluster = news.isCluster === true;

      let current = yield* observe(env.project, id, output?.name);

      if (current === undefined) {
        const created = yield* monitoring
          .createProjectsGroups({
            name: parentOf(env.project),
            body: {
              displayName: encodedDisplayName,
              filter: news.filter,
              parentName: news.parentName,
              isCluster: desiredCluster,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(env.project, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new GroupNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const needsUpdate =
        (current.displayName ?? "") !== encodedDisplayName ||
        (current.filter ?? "") !== news.filter ||
        (current.parentName ?? "") !== desiredParent ||
        (current.isCluster === true) !== desiredCluster;

      if (needsUpdate) {
        current = yield* monitoring
          .updateProjectsGroups({
            name,
            body: {
              name,
              displayName: encodedDisplayName,
              filter: news.filter,
              parentName: desiredParent,
              isCluster: desiredCluster,
            },
          })
          .pipe(retryConcurrentEdits);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteProjectsGroups({ name: output.name, recursive: true })
        .pipe(
          retryConcurrentEdits,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
