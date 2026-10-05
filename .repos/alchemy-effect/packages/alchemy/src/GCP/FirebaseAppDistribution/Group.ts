import * as firebaseappdistribution from "@distilled.cloud/gcp/firebaseappdistribution_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  getGroup,
  groupIdOf,
  groupName,
  hasOwnershipMarker,
  listGroups,
  parseDisplayName,
  parseGroupName,
  projectParent,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameText,
  toDisplayName,
  toGroupId,
} from "./internal.ts";

export type GroupProps = {
  /**
   * Group alias (the `{group}` segment of
   * `projects/{project}/groups/{group}`). 4-63 characters: lowercase
   * letters, digits, and hyphens. If omitted, a unique id is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the group.
   */
  groupId?: string;
  /**
   * Display name shown to testers. Defaults to a generated name.
   */
  displayName?: string;
};

export type Group = Resource<
  "GCP.FirebaseAppDistribution.Group",
  GroupProps,
  {
    /** Full resource name `projects/{project}/groups/{group}`. */
    name: string;
    /** Group alias (last path segment). */
    groupId: string;
    /** Parent project id. */
    project: string;
    /** Parent resource `projects/{project}`. */
    parent: string;
    /** Display name (a legacy Alchemy ownership prefix is stripped). */
    displayName: string | undefined;
    /** Number of testers who are members of this group. */
    testerCount: number | undefined;
    /** Number of invite links for this group. */
    inviteLinkCount: number | undefined;
    /** Number of releases this group is permitted to access. */
    releaseCount: number | undefined;
  },
  never,
  Providers
>;

/**
 * A Firebase App Distribution tester group.
 *
 * Groups have no labels field, and the display name is shown to testers,
 * so Alchemy writes no ownership marker: a generated alias identifies the
 * group, and `read` reports an explicit alias it has no state for as
 * unowned. `groupId` is identity — changing it
 * replaces the group. Display name updates in place.
 *
 * ### Creating a Group
 * **Example:** Generated alias
 * ```typescript
 * const group = yield* GCP.FirebaseAppDistribution.Group("Qa", {
 *   displayName: "qa",
 * });
 * ```
 *
 * **Example:** Explicit alias
 * ```typescript
 * const group = yield* GCP.FirebaseAppDistribution.Group("Qa", {
 *   groupId: "qa-testers",
 *   displayName: "qa",
 * });
 * ```
 *
 * ### Updating a Group
 * **Example:** Rename
 * ```typescript
 * const group = yield* GCP.FirebaseAppDistribution.Group("Qa", {
 *   displayName: "qa-prod",
 * });
 * ```
 *
 * @resource
 * @category FirebaseAppDistribution
 */
export const Group = Resource<Group>("GCP.FirebaseAppDistribution.Group");

const toAttrs = (
  group: firebaseappdistribution.GoogleFirebaseAppdistroV1Group,
  project: string,
): Group["Attributes"] => {
  const name = group.name ?? "";
  const parsed = parseGroupName(name, project);
  return {
    name,
    groupId: parsed.groupId,
    project: parsed.project || project,
    parent: parsed.parent || projectParent(project),
    displayName: parseDisplayName(group.displayName).displayName,
    testerCount: group.testerCount,
    inviteLinkCount: group.inviteLinkCount,
    releaseCount: group.releaseCount,
  };
};

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["name", "groupId", "project", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = groupIdOf(olds?.groupId ?? output?.groupId);
      const next = groupIdOf(news.groupId);
      return replaceOnIdentity(previous, next);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const groupId = yield* toGroupId(
        id,
        olds?.groupId ?? output?.groupId,
        output?.name,
      );
      const existing = yield* getGroup(
        output?.name ?? groupName(env.project, groupId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels, and the display name is shown to testers: a generated
      // alias derives from this stack, stage, logical id and instance; an
      // explicit alias is only ours when state has it.
      return output !== undefined || olds?.groupId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const groups = yield* listGroups(projectParent(env.project));
        return groups
          .filter((group) => hasOwnershipMarker(group.displayName))
          .map((group) => toAttrs(group, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = projectParent(env.project);
      const groupId = yield* toGroupId(
        id,
        news.groupId,
        output?.groupId ?? output?.name,
      );
      const name = groupName(env.project, groupId);
      const desiredDisplay = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );

      let current = yield* getGroup(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          firebaseappdistribution.createProjectsGroups({
            parent,
            groupId,
            body: { displayName: desiredDisplay },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getGroup(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: output?.name ?? name,
        });
      }

      const currentName = current.name ?? name;
      if (
        !sameText(current.displayName, desiredDisplay) &&
        currentName.length > 0
      ) {
        current = yield* retryTransient(
          firebaseappdistribution.patchProjectsGroups({
            name: currentName,
            updateMask: "display_name",
            body: { displayName: desiredDisplay },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        firebaseappdistribution.deleteProjectsGroups({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
