import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface GetCodeInterpreterSessionRequest extends Omit<
  agentcore.GetCodeInterpreterSessionRequest,
  "codeInterpreterIdentifier"
> {}

/**
 * Reads a code interpreter session's configuration and status.
 *
 * Bind a {@link CodeInterpreter} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetCodeInterpreterSessionHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Inspecting Sessions
 * @example Read a Session
 * ```typescript
 * // init
 * const getCodeInterpreterSession = yield* AgentCore.GetCodeInterpreterSession(codeInterpreter);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getCodeInterpreterSession({ sessionId });
 *     return HttpServerResponse.json({ status: result.status });
 *   }),
 * };
 * ```
 */
export interface GetCodeInterpreterSession extends Binding.Service<
  GetCodeInterpreterSession,
  "AWS.BedrockAgentCore.GetCodeInterpreterSession",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: GetCodeInterpreterSessionRequest,
    ) => Effect.Effect<
      agentcore.GetCodeInterpreterSessionResponse,
      agentcore.GetCodeInterpreterSessionError
    >
  >
> {}
export const GetCodeInterpreterSession =
  Binding.Service<GetCodeInterpreterSession>(
    "AWS.BedrockAgentCore.GetCodeInterpreterSession",
  );
