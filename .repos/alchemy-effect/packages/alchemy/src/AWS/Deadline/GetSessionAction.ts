import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:GetSessionAction`.
 *
 * Reads one session action's detail (status, timing, exit code, progress,
 * definition) for a job in the bound {@link Queue}. The queue's
 * `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.GetSessionActionHttp)`.
 * @binding
 * @section Monitoring Sessions
 * @example Inspect A Session Action
 * ```typescript
 * // init — bind the operation to the queue
 * const getSessionAction = yield* AWS.Deadline.GetSessionAction(queue);
 *
 * // runtime
 * const action = yield* getSessionAction({ jobId, sessionActionId });
 * if (action.processExitCode !== undefined && action.processExitCode !== 0) {
 *   yield* Effect.logError(`action failed: ${action.processExitCode}`);
 * }
 * ```
 */
export interface GetSessionAction extends Binding.Service<
  GetSessionAction,
  "AWS.Deadline.GetSessionAction",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetSessionActionRequest, "farmId" | "queueId">,
    ) => Effect.Effect<
      deadline.GetSessionActionResponse,
      deadline.GetSessionActionError
    >
  >
> {}
export const GetSessionAction = Binding.Service<GetSessionAction>(
  "AWS.Deadline.GetSessionAction",
);
