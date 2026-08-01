import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AgentAlias } from "./AgentAlias.ts";

/**
 * The `DeleteAgentMemory` request with the binding-injected `agentId` and
 * `agentAliasId` removed — they are supplied automatically from the bound
 * {@link AgentAlias}.
 */
export interface DeleteAgentMemoryRequest extends Omit<
  bedrock.DeleteAgentMemoryRequest,
  "agentId" | "agentAliasId"
> {}

/**
 * Runtime binding for `bedrock-agent-runtime:DeleteAgentMemory` — delete the
 * memory an agent has stored, for one session, one memory id, or everything.
 *
 * Bind an {@link AgentAlias} inside a function runtime to get a callable
 * that clears the agent's long-term memory. The binding grants the function
 * `bedrock:DeleteAgentMemory` scoped to exactly that alias. Deletion is
 * idempotent — deleting a session or memory id that holds no memory
 * succeeds.
 *
 * @binding
 * @section Deleting Agent Memory
 * @example Forget One Session
 * ```typescript
 * // init
 * const deleteAgentMemory = yield* Bedrock.DeleteAgentMemory(alias);
 *
 * // runtime
 * yield* deleteAgentMemory({ sessionId });
 * ```
 *
 * @example Forget Everything for a Memory Id
 * ```typescript
 * yield* deleteAgentMemory({ memoryId: userId });
 * ```
 */
export interface DeleteAgentMemory extends Binding.Service<
  DeleteAgentMemory,
  "AWS.Bedrock.DeleteAgentMemory",
  <A extends AgentAlias>(
    alias: A,
  ) => Effect.Effect<
    (
      request: DeleteAgentMemoryRequest,
    ) => Effect.Effect<
      bedrock.DeleteAgentMemoryResponse,
      bedrock.DeleteAgentMemoryError
    >
  >
> {}
export const DeleteAgentMemory = Binding.Service<DeleteAgentMemory>(
  "AWS.Bedrock.DeleteAgentMemory",
);
