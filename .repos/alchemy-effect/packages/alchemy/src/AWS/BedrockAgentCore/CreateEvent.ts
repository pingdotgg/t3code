import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface CreateEventRequest extends Omit<
  agentcore.CreateEventInput,
  "memoryId"
> {}

/**
 * Records an interaction event into a memory's short-term store.
 *
 * Bind a {@link Memory} inside a function runtime to get a callable that
 * appends conversational turns (or binary blobs) to an actor's session.
 * Provide `AgentCore.CreateEventHttp` on the Function effect to implement
 * the binding over the AgentCore data-plane API.
 *
 * @binding
 * @section Recording Events
 * @example Record a Conversational Turn from a Lambda Function
 * ```typescript
 * import * as AgentCore from "alchemy/AWS/BedrockAgentCore";
 *
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const memory = yield* AgentCore.Memory("AgentMemory", {
 *       eventExpiryDuration: "30 days",
 *     });
 *
 *     // init
 *     const createEvent = yield* AgentCore.CreateEvent(memory);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const result = yield* createEvent({
 *           actorId: "user-1",
 *           sessionId: "session-1",
 *           eventTimestamp: new Date(),
 *           payload: [
 *             {
 *               conversational: {
 *                 role: "USER",
 *                 content: { text: "My favorite color is teal." },
 *               },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.json({ eventId: result.event.eventId });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AgentCore.CreateEventHttp)),
 * );
 * ```
 */
export interface CreateEvent extends Binding.Service<
  CreateEvent,
  "AWS.BedrockAgentCore.CreateEvent",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: CreateEventRequest,
    ) => Effect.Effect<agentcore.CreateEventOutput, agentcore.CreateEventError>
  >
> {}
export const CreateEvent = Binding.Service<CreateEvent>(
  "AWS.BedrockAgentCore.CreateEvent",
);
