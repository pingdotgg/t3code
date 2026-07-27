import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListEventsRequest extends Omit<
  agentcore.ListEventsInput,
  "memoryId"
> {}

/**
 * Lists the events of an actor's session in a memory's short-term store.
 *
 * Bind a {@link Memory} inside a function runtime to page through the raw
 * events recorded with `CreateEvent`. Provide `AgentCore.ListEventsHttp` on
 * the Function effect to implement the binding.
 *
 * @binding
 * @section Listing Events
 * @example List a Session's Events
 * ```typescript
 * // init
 * const listEvents = yield* AgentCore.ListEvents(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listEvents({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *     });
 *     return HttpServerResponse.json({ count: result.events.length });
 *   }),
 * };
 * ```
 */
export interface ListEvents extends Binding.Service<
  ListEvents,
  "AWS.BedrockAgentCore.ListEvents",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListEventsRequest,
    ) => Effect.Effect<agentcore.ListEventsOutput, agentcore.ListEventsError>
  >
> {}
export const ListEvents = Binding.Service<ListEvents>(
  "AWS.BedrockAgentCore.ListEvents",
);
