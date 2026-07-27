import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface StopBrowserSessionRequest extends Omit<
  agentcore.StopBrowserSessionRequest,
  "browserIdentifier"
> {}

/**
 * Terminates an active browser session.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.StopBrowserSessionHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Sessions
 * @example Stop a Session
 * ```typescript
 * // init
 * const stopBrowserSession = yield* AgentCore.StopBrowserSession(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* stopBrowserSession({ sessionId });
 *     return HttpServerResponse.json({ stopped: true });
 *   }),
 * };
 * ```
 */
export interface StopBrowserSession extends Binding.Service<
  StopBrowserSession,
  "AWS.BedrockAgentCore.StopBrowserSession",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: StopBrowserSessionRequest,
    ) => Effect.Effect<
      agentcore.StopBrowserSessionResponse,
      agentcore.StopBrowserSessionError
    >
  >
> {}
export const StopBrowserSession = Binding.Service<StopBrowserSession>(
  "AWS.BedrockAgentCore.StopBrowserSession",
);
