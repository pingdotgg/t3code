import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface GetBrowserSessionRequest extends Omit<
  agentcore.GetBrowserSessionRequest,
  "browserIdentifier"
> {}

/**
 * Reads a browser session's configuration, status, and stream endpoints.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetBrowserSessionHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Sessions
 * @example Read a Session
 * ```typescript
 * // init
 * const getBrowserSession = yield* AgentCore.GetBrowserSession(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getBrowserSession({ sessionId });
 *     return HttpServerResponse.json({ status: result.status });
 *   }),
 * };
 * ```
 */
export interface GetBrowserSession extends Binding.Service<
  GetBrowserSession,
  "AWS.BedrockAgentCore.GetBrowserSession",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: GetBrowserSessionRequest,
    ) => Effect.Effect<
      agentcore.GetBrowserSessionResponse,
      agentcore.GetBrowserSessionError
    >
  >
> {}
export const GetBrowserSession = Binding.Service<GetBrowserSession>(
  "AWS.BedrockAgentCore.GetBrowserSession",
);
