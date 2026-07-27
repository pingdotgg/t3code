import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export interface StartCodeInterpreterSessionRequest extends Omit<
  agentcore.StartCodeInterpreterSessionRequest,
  "codeInterpreterIdentifier" | "sessionTimeoutSeconds"
> {
  /**
   * How long the session may sit idle before AgentCore terminates it, e.g.
   * `"5 minutes"` or `Duration.minutes(5)` (a bare number is milliseconds).
   */
  sessionTimeout?: Duration.Input;
}

/**
 * Starts an isolated code-execution session on a code interpreter.
 *
 * Bind a {@link CodeInterpreter} inside a function runtime to open sandboxed
 * sessions; pair with `InvokeCodeInterpreter` to run code in the session and
 * `StopCodeInterpreterSession` to end it. Provide
 * `AgentCore.StartCodeInterpreterSessionHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Running Code
 * @example Start a Session, Execute Code, Stop
 * ```typescript
 * // init
 * const startSession = yield* AgentCore.StartCodeInterpreterSession(interpreter);
 * const invoke = yield* AgentCore.InvokeCodeInterpreter(interpreter);
 * const stopSession = yield* AgentCore.StopCodeInterpreterSession(interpreter);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const session = yield* startSession({ sessionTimeout: "5 minutes" });
 *     const result = yield* invoke({
 *       sessionId: session.sessionId,
 *       name: "executeCode",
 *       arguments: { language: "python", code: "print(21 * 2)" },
 *     });
 *     const chunks = yield* Stream.runCollect(result.stream);
 *     yield* stopSession({ sessionId: session.sessionId });
 *     return HttpServerResponse.json({ chunks: Array.from(chunks) });
 *   }),
 * };
 * ```
 */
export interface StartCodeInterpreterSession extends Binding.Service<
  StartCodeInterpreterSession,
  "AWS.BedrockAgentCore.StartCodeInterpreterSession",
  <R extends CodeInterpreter>(
    codeInterpreter: R,
  ) => Effect.Effect<
    (
      request: StartCodeInterpreterSessionRequest,
    ) => Effect.Effect<
      agentcore.StartCodeInterpreterSessionResponse,
      agentcore.StartCodeInterpreterSessionError
    >
  >
> {}
export const StartCodeInterpreterSession =
  Binding.Service<StartCodeInterpreterSession>(
    "AWS.BedrockAgentCore.StartCodeInterpreterSession",
  );
