import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface DeleteEventRequest extends Omit<
  agentcore.DeleteEventInput,
  "memoryId"
> {}

/**
 * Deletes a short-term event from an actor's session.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.DeleteEventHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Deleting Events
 * @example Delete an Event by Id
 * ```typescript
 * // init
 * const deleteEvent = yield* AgentCore.DeleteEvent(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* deleteEvent({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *       eventId,
 *     });
 *     return HttpServerResponse.json({ deleted: true });
 *   }),
 * };
 * ```
 */
export interface DeleteEvent extends Binding.Service<
  DeleteEvent,
  "AWS.BedrockAgentCore.DeleteEvent",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: DeleteEventRequest,
    ) => Effect.Effect<agentcore.DeleteEventOutput, agentcore.DeleteEventError>
  >
> {}
export const DeleteEvent = Binding.Service<DeleteEvent>(
  "AWS.BedrockAgentCore.DeleteEvent",
);
