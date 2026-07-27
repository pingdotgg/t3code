import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface StartBrowserSessionRequest extends Omit<
  agentcore.StartBrowserSessionRequest,
  "browserIdentifier" | "sessionTimeoutSeconds"
> {
  /**
   * How long the session may sit idle before AgentCore terminates it, e.g.
   * `"5 minutes"` or `Duration.minutes(5)` (a bare number is milliseconds).
   */
  sessionTimeout?: Duration.Input;
}

/**
 * Starts a managed, sandboxed browser session on a custom browser.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to open cloud
 * browser sessions for web automation; pair with `GetBrowserSession`,
 * `InvokeBrowser`, and `StopBrowserSession`. Provide
 * `AgentCore.StartBrowserSessionHttp` on the Function effect to implement
 * the binding.
 *
 * @binding
 * @section Browser Sessions
 * @example Start and Stop a Browser Session
 * ```typescript
 * // init
 * const startBrowserSession = yield* AgentCore.StartBrowserSession(browser);
 * const stopBrowserSession = yield* AgentCore.StopBrowserSession(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const session = yield* startBrowserSession({
 *       sessionTimeout: "5 minutes",
 *     });
 *     yield* stopBrowserSession({ sessionId: session.sessionId });
 *     return HttpServerResponse.json({ sessionId: session.sessionId });
 *   }),
 * };
 * ```
 */
export interface StartBrowserSession extends Binding.Service<
  StartBrowserSession,
  "AWS.BedrockAgentCore.StartBrowserSession",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: StartBrowserSessionRequest,
    ) => Effect.Effect<
      agentcore.StartBrowserSessionResponse,
      agentcore.StartBrowserSessionError
    >
  >
> {}
export const StartBrowserSession = Binding.Service<StartBrowserSession>(
  "AWS.BedrockAgentCore.StartBrowserSession",
);
