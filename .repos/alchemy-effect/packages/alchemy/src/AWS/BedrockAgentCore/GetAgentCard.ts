import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Runtime } from "./Runtime.ts";

export interface GetAgentCardRequest extends Omit<
  agentcore.GetAgentCardRequest,
  "agentRuntimeArn"
> {}

/**
 * Fetches the A2A agent card describing the agent runtime's capabilities.
 *
 * Bind a {@link Runtime} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetAgentCardHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Agent Discovery
 * @example Fetch the Agent Card
 * ```typescript
 * // init
 * const getAgentCard = yield* AgentCore.GetAgentCard(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getAgentCard({});
 *     return HttpServerResponse.json({ card: result.agentCard });
 *   }),
 * };
 * ```
 */
export interface GetAgentCard extends Binding.Service<
  GetAgentCard,
  "AWS.BedrockAgentCore.GetAgentCard",
  <R extends Runtime>(
    runtime: R,
  ) => Effect.Effect<
    (
      request: GetAgentCardRequest,
    ) => Effect.Effect<
      agentcore.GetAgentCardResponse,
      agentcore.GetAgentCardError
    >
  >
> {}
export const GetAgentCard = Binding.Service<GetAgentCard>(
  "AWS.BedrockAgentCore.GetAgentCard",
);
