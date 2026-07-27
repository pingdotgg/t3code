import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AgentAlias } from "./AgentAlias.ts";

/**
 * The `GetAgentMemory` request with the binding-injected `agentId` and
 * `agentAliasId` removed — they are supplied automatically from the bound
 * {@link AgentAlias}.
 */
export interface GetAgentMemoryRequest extends Omit<
  bedrock.GetAgentMemoryRequest,
  "agentId" | "agentAliasId"
> {}

/**
 * Runtime binding for `bedrock-agent-runtime:GetAgentMemory` — retrieve the
 * session summaries an agent has stored for a memory id.
 *
 * Bind an {@link AgentAlias} inside a function runtime to get a callable
 * that reads the agent's long-term memory. The binding grants the function
 * `bedrock:GetAgentMemory` scoped to exactly that alias. The agent must have
 * memory enabled (see `Agent`'s `memoryConfiguration` prop); summaries are
 * generated asynchronously after a session ends.
 *
 * @binding
 * @section Reading Agent Memory
 * @example List Session Summaries for a Memory Id
 * ```typescript
 * // init
 * const getAgentMemory = yield* Bedrock.GetAgentMemory(alias);
 *
 * // runtime
 * const result = yield* getAgentMemory({
 *   memoryType: "SESSION_SUMMARY",
 *   memoryId: userId,
 *   maxItems: 10,
 * });
 * const summaries = (result.memoryContents ?? []).map(
 *   (memory) => memory.sessionSummary?.summaryText,
 * );
 * ```
 */
export interface GetAgentMemory extends Binding.Service<
  GetAgentMemory,
  "AWS.Bedrock.GetAgentMemory",
  <A extends AgentAlias>(
    alias: A,
  ) => Effect.Effect<
    (
      request: GetAgentMemoryRequest,
    ) => Effect.Effect<
      bedrock.GetAgentMemoryResponse,
      bedrock.GetAgentMemoryError
    >
  >
> {}
export const GetAgentMemory = Binding.Service<GetAgentMemory>(
  "AWS.Bedrock.GetAgentMemory",
);
