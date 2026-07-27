import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListSessions`.
 *
 * Enumerates the worker sessions of a job in the bound {@link Queue}
 * (paginated). The queue's `farmId`/`queueId` are injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.ListSessionsHttp)`.
 * @binding
 * @section Monitoring Sessions
 * @example List A Job's Sessions
 * ```typescript
 * // init — bind the operation to the queue
 * const listSessions = yield* AWS.Deadline.ListSessions(queue);
 *
 * // runtime
 * const { sessions } = yield* listSessions({ jobId });
 * ```
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.Deadline.ListSessions",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.ListSessionsRequest, "farmId" | "queueId">,
    ) => Effect.Effect<
      deadline.ListSessionsResponse,
      deadline.ListSessionsError
    >
  >
> {}
export const ListSessions = Binding.Service<ListSessions>(
  "AWS.Deadline.ListSessions",
);
