import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:GetSession`.
 *
 * Reads a worker session's detail for a job in the bound {@link Queue} —
 * lifecycle status, host properties, worker log configuration. The queue's
 * `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.GetSessionHttp)`.
 * @binding
 * @section Monitoring Sessions
 * @example Inspect A Session
 * ```typescript
 * // init — bind the operation to the queue
 * const getSession = yield* AWS.Deadline.GetSession(queue);
 *
 * // runtime
 * const session = yield* getSession({ jobId, sessionId });
 * ```
 */
export interface GetSession extends Binding.Service<
  GetSession,
  "AWS.Deadline.GetSession",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetSessionRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.GetSessionResponse, deadline.GetSessionError>
  >
> {}
export const GetSession = Binding.Service<GetSession>(
  "AWS.Deadline.GetSession",
);
