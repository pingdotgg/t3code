import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-groups:CancelTagSyncTask`.
 *
 * Cancels a running tag-sync task. Group membership stops being synced to
 * the tag, but resources already grouped keep their membership. The task
 * ARN is chosen per request, so the grant is on `*`. Provide the
 * implementation with `Effect.provide(AWS.ResourceGroups.CancelTagSyncTaskHttp)`.
 * @binding
 * @section Tag-Sync Tasks
 * @example Cancel A Task
 * ```typescript
 * // init
 * const cancelTagSyncTask = yield* AWS.ResourceGroups.CancelTagSyncTask();
 *
 * // runtime
 * yield* cancelTagSyncTask({ TaskArn: taskArn });
 * ```
 */
export interface CancelTagSyncTask extends Binding.Service<
  CancelTagSyncTask,
  "AWS.ResourceGroups.CancelTagSyncTask",
  () => Effect.Effect<
    (
      request: resourcegroups.CancelTagSyncTaskInput,
    ) => Effect.Effect<
      resourcegroups.CancelTagSyncTaskResponse,
      resourcegroups.CancelTagSyncTaskError
    >
  >
> {}
export const CancelTagSyncTask = Binding.Service<CancelTagSyncTask>(
  "AWS.ResourceGroups.CancelTagSyncTask",
);
