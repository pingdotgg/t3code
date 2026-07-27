import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface StopCodeInterpreterSessionRequest extends Omit<
  agentcore.StopCodeInterpreterSessionRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Stops a running code interpreter session.
 *
 * Bind a {@link CodeInterpreter} inside a function runtime to end sessions
 * opened with `StartCodeInterpreterSession` and release the sandbox.
 * Provide `AgentCore.StopCodeInterpreterSessionHttp` on the Function effect
 * to implement the binding.
 *
 * @binding
 * @section Stopping Sessions
 * @example Stop a Session After Use
 * ```typescript
 * // init
 * const stopSession = yield* AgentCore.StopCodeInterpreterSession(interpreter);
 *
 * // runtime (inside the handler)
 * yield* stopSession({ sessionId: session.sessionId });
 * ```
 */
export interface StopCodeInterpreterSession extends Binding.Service<
  StopCodeInterpreterSession,
  "AWS.BedrockAgentCore.StopCodeInterpreterSession",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: StopCodeInterpreterSessionRequest,
    ) => Effect.Effect<
      agentcore.StopCodeInterpreterSessionResponse,
      agentcore.StopCodeInterpreterSessionError
    >
  >
> {}
export const StopCodeInterpreterSession =
  Binding.Service<StopCodeInterpreterSession>(
    "AWS.BedrockAgentCore.StopCodeInterpreterSession",
  );
