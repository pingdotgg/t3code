import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListSessionsRequest extends Omit<
  agentcore.ListSessionsInput,
  "memoryId"
> {}

/**
 * Lists an actor's sessions in a memory.
 *
 * Bind a {@link Memory} inside a function runtime to enumerate the sessions
 * an actor has recorded events under. Provide `AgentCore.ListSessionsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Listing Sessions
 * @example List an Actor's Sessions
 * ```typescript
 * // init
 * const listSessions = yield* AgentCore.ListSessions(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listSessions({ actorId: "user-1" });
 *     return HttpServerResponse.json({
 *       count: result.sessionSummaries.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.BedrockAgentCore.ListSessions",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListSessionsRequest,
    ) => Effect.Effect<
      agentcore.ListSessionsOutput,
      agentcore.ListSessionsError
    >
  >
> {}
export const ListSessions = Binding.Service<ListSessions>(
  "AWS.BedrockAgentCore.ListSessions",
);
