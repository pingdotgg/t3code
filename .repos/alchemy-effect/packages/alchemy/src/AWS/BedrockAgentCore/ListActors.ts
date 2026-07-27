import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Memory } from "./Memory.ts";

export interface ListActorsRequest extends Omit<
  agentcore.ListActorsInput,
  "memoryId"
> {}

/**
 * Lists the actors that have recorded events in the memory.
 *
 * Bind a {@link Memory} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListActorsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Listing Actors
 * @example List Actors
 * ```typescript
 * // init
 * const listActors = yield* AgentCore.ListActors(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listActors({});
 *     return HttpServerResponse.json({
 *       count: result.actorSummaries.length,
 *     });
 *   }),
 * };
 * ```
 */
export interface ListActors extends Binding.Service<
  ListActors,
  "AWS.BedrockAgentCore.ListActors",
  <R extends Memory>(
    memory: R,
  ) => Effect.Effect<
    (
      request: ListActorsRequest,
    ) => Effect.Effect<agentcore.ListActorsOutput, agentcore.ListActorsError>
  >
> {}
export const ListActors = Binding.Service<ListActors>(
  "AWS.BedrockAgentCore.ListActors",
);
