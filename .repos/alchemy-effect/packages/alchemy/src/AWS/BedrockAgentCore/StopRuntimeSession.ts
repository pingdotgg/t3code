import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Runtime } from "./Runtime.ts";

export interface StopRuntimeSessionRequest extends Omit<
  agentcore.StopRuntimeSessionRequest,
  "agentRuntimeArn"
> {}

/**
 * Stops a specific session on the agent runtime.
 *
 * Bind a {@link Runtime} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.StopRuntimeSessionHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Runtime Sessions
 * @example Stop a Runtime Session
 * ```typescript
 * // init
 * const stopRuntimeSession = yield* AgentCore.StopRuntimeSession(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* stopRuntimeSession({ runtimeSessionId });
 *     return HttpServerResponse.json({ stopped: true });
 *   }),
 * };
 * ```
 */
export interface StopRuntimeSession extends Binding.Service<
  StopRuntimeSession,
  "AWS.BedrockAgentCore.StopRuntimeSession",
  <R extends Runtime>(
    runtime: R,
  ) => Effect.Effect<
    (
      request: StopRuntimeSessionRequest,
    ) => Effect.Effect<
      agentcore.StopRuntimeSessionResponse,
      agentcore.StopRuntimeSessionError
    >
  >
> {}
export const StopRuntimeSession = Binding.Service<StopRuntimeSession>(
  "AWS.BedrockAgentCore.StopRuntimeSession",
);
