import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { Group } from "./Group.ts";

/**
 * Request for {@link StartTagSyncTask} — the group and (by default) the
 * bound role are injected from the binding; pass `RoleArn` to override.
 */
export type StartTagSyncTaskRequest = Omit<
  resourcegroups.StartTagSyncTaskInput,
  "Group" | "RoleArn"
> & { RoleArn?: string };

/**
 * Runtime binding for `resource-groups:StartTagSyncTask`.
 *
 * Starts a tag-sync task on the bound application {@link Group}: Resource
 * Groups continuously adds resources carrying the tag (or matching the
 * resource query) to the group and removes ones that stop matching, acting
 * as the bound IAM role. The binding grants the action on the group plus
 * `iam:PassRole` on the role (condition-scoped to
 * `resource-groups.amazonaws.com`); the role itself needs the tagging
 * permissions tag-sync uses and a trust policy for
 * `resource-groups.amazonaws.com`. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.StartTagSyncTaskHttp)`.
 * @binding
 * @section Tag-Sync Tasks
 * @example Keep A Group In Sync With A Tag
 * ```typescript
 * // init — bind the operation to the group and the sync role
 * const startTagSyncTask = yield* AWS.ResourceGroups.StartTagSyncTask(group, syncRole);
 *
 * // runtime
 * const { TaskArn } = yield* startTagSyncTask({
 *   TagKey: "team",
 *   TagValue: "platform",
 * });
 * ```
 */
export interface StartTagSyncTask extends Binding.Service<
  StartTagSyncTask,
  "AWS.ResourceGroups.StartTagSyncTask",
  <R extends Role>(
    group: Group,
    syncRole: R,
  ) => Effect.Effect<
    (
      request: StartTagSyncTaskRequest,
    ) => Effect.Effect<
      resourcegroups.StartTagSyncTaskOutput,
      resourcegroups.StartTagSyncTaskError
    >
  >
> {}
export const StartTagSyncTask = Binding.Service<StartTagSyncTask>(
  "AWS.ResourceGroups.StartTagSyncTask",
);
