import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-groups:ListTagSyncTasks`.
 *
 * Enumerates the account's tag-sync tasks (optionally filtered to a
 * specific group) with each task's status — how an ops function audits
 * which groups are kept in sync with a tag and alerts on tasks in `ERROR`.
 * Account-level: tasks span groups, so the grant is on `*`. Provide the
 * implementation with `Effect.provide(AWS.ResourceGroups.ListTagSyncTasksHttp)`.
 * @binding
 * @section Tag-Sync Tasks
 * @example List A Group's Tag-Sync Tasks
 * ```typescript
 * // init
 * const listTagSyncTasks = yield* AWS.ResourceGroups.ListTagSyncTasks();
 *
 * // runtime
 * const { TagSyncTasks } = yield* listTagSyncTasks({
 *   Filters: [{ GroupName: "my-application" }],
 * });
 * ```
 */
export interface ListTagSyncTasks extends Binding.Service<
  ListTagSyncTasks,
  "AWS.ResourceGroups.ListTagSyncTasks",
  () => Effect.Effect<
    (
      request?: resourcegroups.ListTagSyncTasksInput,
    ) => Effect.Effect<
      resourcegroups.ListTagSyncTasksOutput,
      resourcegroups.ListTagSyncTasksError
    >
  >
> {}
export const ListTagSyncTasks = Binding.Service<ListTagSyncTasks>(
  "AWS.ResourceGroups.ListTagSyncTasks",
);
