import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface UpdateBrowserStreamRequest extends Omit<
  agentcore.UpdateBrowserStreamRequest,
  "browserIdentifier"
> {}

/**
 * Updates a browser session's automation stream.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.UpdateBrowserStreamHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Automation
 * @example Release the Automation Stream
 * ```typescript
 * // init
 * const updateBrowserStream = yield* AgentCore.UpdateBrowserStream(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* updateBrowserStream({
 *       sessionId,
 *       streamUpdate: {
 *         automationStreamUpdate: { streamStatus: "ENABLED" },
 *       },
 *     });
 *     return HttpServerResponse.json({ updated: true });
 *   }),
 * };
 * ```
 */
export interface UpdateBrowserStream extends Binding.Service<
  UpdateBrowserStream,
  "AWS.BedrockAgentCore.UpdateBrowserStream",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: UpdateBrowserStreamRequest,
    ) => Effect.Effect<
      agentcore.UpdateBrowserStreamResponse,
      agentcore.UpdateBrowserStreamError
    >
  >
> {}
export const UpdateBrowserStream = Binding.Service<UpdateBrowserStream>(
  "AWS.BedrockAgentCore.UpdateBrowserStream",
);
