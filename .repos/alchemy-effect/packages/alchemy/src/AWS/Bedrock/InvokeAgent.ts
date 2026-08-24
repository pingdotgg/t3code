import type * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AgentAlias } from "./AgentAlias.ts";

/**
 * The `InvokeAgent` request with the binding-injected `agentId` and
 * `agentAliasId` removed — they are supplied automatically from the bound
 * {@link AgentAlias}.
 */
export interface InvokeAgentRequest extends Omit<
  bedrock.InvokeAgentRequest,
  "agentId" | "agentAliasId"
> {}

/**
 * Runtime binding for `bedrock-agent-runtime:InvokeAgent` — send user input
 * to a Bedrock agent through one of its aliases and receive the agent's
 * response as an event stream.
 *
 * Bind an {@link AgentAlias} inside a function runtime to get a callable
 * that invokes the agent. The binding grants the function
 * `bedrock:InvokeAgent` scoped to exactly that alias. The response's
 * `completion` is an event `Stream` of chunks (and traces when
 * `enableTrace` is set); concatenate the chunk bytes to recover the answer.
 *
 * @binding
 * @section Invoking an Agent
 * @example Invoke and Aggregate the Completion
 * ```typescript
 * // init
 * const invokeAgent = yield* Bedrock.InvokeAgent(alias);
 *
 * // runtime
 * const result = yield* invokeAgent({
 *   sessionId: crypto.randomUUID(),
 *   inputText: "What is the capital of France?",
 * });
 * const events = yield* Stream.runCollect(result.completion);
 * const decoder = new TextDecoder();
 * const answer = events
 *   .map((event) =>
 *     event.chunk?.bytes !== undefined
 *       ? decoder.decode(
 *           Redacted.isRedacted(event.chunk.bytes)
 *             ? Redacted.value(event.chunk.bytes)
 *             : event.chunk.bytes,
 *         )
 *       : "",
 *   )
 *   .join("");
 * ```
 *
 * @example Continue a Session
 * ```typescript
 * // Reuse the same sessionId across calls to keep conversational context.
 * const followUp = yield* invokeAgent({
 *   sessionId,
 *   inputText: "And its population?",
 * });
 * ```
 */
export interface InvokeAgent extends Binding.Service<
  InvokeAgent,
  "AWS.Bedrock.InvokeAgent",
  <A extends AgentAlias>(
    alias: A,
  ) => Effect.Effect<
    (
      request: InvokeAgentRequest,
    ) => Effect.Effect<bedrock.InvokeAgentResponse, bedrock.InvokeAgentError>
  >
> {}
export const InvokeAgent = Binding.Service<InvokeAgent>(
  "AWS.Bedrock.InvokeAgent",
);
