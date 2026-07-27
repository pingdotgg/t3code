import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Runtime } from "./Runtime.ts";

export interface InvokeAgentRuntimeCommandRequest extends Omit<
  agentcore.InvokeAgentRuntimeCommandRequest,
  "agentRuntimeArn"
> {}

/**
 * Runs a shell command inside an agent hosted in an AgentCore Runtime and
 * streams back the command output.
 *
 * Bind a {@link Runtime} inside a function runtime to execute commands in
 * the hosted agent's sandbox (requests with the same `runtimeSessionId`
 * land on the same sandbox). Provide
 * `AgentCore.InvokeAgentRuntimeCommandHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Invoking an Agent
 * @example Run a Command in a Hosted Agent
 * ```typescript
 * // init
 * const invokeCommand = yield* AgentCore.InvokeAgentRuntimeCommand(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const response = yield* invokeCommand({
 *       runtimeSessionId: "session-0000000000000000000000000000000001",
 *       body: { command: "echo hello" },
 *     });
 *     const chunks = yield* Stream.runCollect(response.stream);
 *     return HttpServerResponse.json({ chunks: Array.from(chunks) });
 *   }),
 * };
 * ```
 */
export interface InvokeAgentRuntimeCommand extends Binding.Service<
  InvokeAgentRuntimeCommand,
  "AWS.BedrockAgentCore.InvokeAgentRuntimeCommand",
  <R extends Runtime>(
    runtime: R,
  ) => Effect.Effect<
    (
      request: InvokeAgentRuntimeCommandRequest,
    ) => Effect.Effect<
      agentcore.InvokeAgentRuntimeCommandResponse,
      agentcore.InvokeAgentRuntimeCommandError
    >
  >
> {}
export const InvokeAgentRuntimeCommand =
  Binding.Service<InvokeAgentRuntimeCommand>(
    "AWS.BedrockAgentCore.InvokeAgentRuntimeCommand",
  );
