import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListSessionActions`.
 *
 * Lists the session actions (environment enter/exit, task runs, attachment
 * syncs) recorded for a job in the bound {@link Queue}, optionally filtered
 * by `sessionId` or `taskId`. The queue's `farmId`/`queueId` are injected
 * from the binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.ListSessionActionsHttp)`.
 * @binding
 * @section Monitoring Sessions
 * @example List A Job's Session Actions
 * ```typescript
 * // init — bind the operation to the queue
 * const listSessionActions = yield* AWS.Deadline.ListSessionActions(queue);
 *
 * // runtime
 * const { sessionActions } = yield* listSessionActions({ jobId });
 * ```
 */
export interface ListSessionActions extends Binding.Service<
  ListSessionActions,
  "AWS.Deadline.ListSessionActions",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.ListSessionActionsRequest, "farmId" | "queueId">,
    ) => Effect.Effect<
      deadline.ListSessionActionsResponse,
      deadline.ListSessionActionsError
    >
  >
> {}
export const ListSessionActions = Binding.Service<ListSessionActions>(
  "AWS.Deadline.ListSessionActions",
);
