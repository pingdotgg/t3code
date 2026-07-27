import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface GetEventRequest extends Omit<
  agentcore.GetEventInput,
  "memoryId"
> {}

/**
 * Fetches a single short-term event from an actor's session.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetEventHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Reading Events
 * @example Fetch an Event by Id
 * ```typescript
 * // init
 * const getEvent = yield* AgentCore.GetEvent(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getEvent({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *       eventId,
 *     });
 *     return HttpServerResponse.json({ event: result.event });
 *   }),
 * };
 * ```
 */
export interface GetEvent extends Binding.Service<
  GetEvent,
  "AWS.BedrockAgentCore.GetEvent",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: GetEventRequest,
    ) => Effect.Effect<agentcore.GetEventOutput, agentcore.GetEventError>
  >
> {}
export const GetEvent = Binding.Service<GetEvent>(
  "AWS.BedrockAgentCore.GetEvent",
);
