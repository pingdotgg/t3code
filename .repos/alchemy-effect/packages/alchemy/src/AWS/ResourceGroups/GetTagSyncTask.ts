import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-groups:GetTagSyncTask`.
 *
 * Reads one tag-sync task's detail — the synced tag key/value, the role it
 * runs as, and its `ACTIVE`/`ERROR` status with the error message. The task
 * ARN is chosen per request (typically the `TaskArn` returned by
 * {@link StartTagSyncTask} or found via {@link ListTagSyncTasks}), so the
 * grant is on `*`. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.GetTagSyncTaskHttp)`.
 * @binding
 * @section Tag-Sync Tasks
 * @example Read A Task's Status
 * ```typescript
 * // init
 * const getTagSyncTask = yield* AWS.ResourceGroups.GetTagSyncTask();
 *
 * // runtime
 * const task = yield* getTagSyncTask({ TaskArn: taskArn });
 * if (task.Status === "ERROR") {
 *   yield* Effect.logError(`tag sync failed: ${task.ErrorMessage}`);
 * }
 * ```
 */
export interface GetTagSyncTask extends Binding.Service<
  GetTagSyncTask,
  "AWS.ResourceGroups.GetTagSyncTask",
  () => Effect.Effect<
    (
      request: resourcegroups.GetTagSyncTaskInput,
    ) => Effect.Effect<
      resourcegroups.GetTagSyncTaskOutput,
      resourcegroups.GetTagSyncTaskError
    >
  >
> {}
export const GetTagSyncTask = Binding.Service<GetTagSyncTask>(
  "AWS.ResourceGroups.GetTagSyncTask",
);
