import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface InvokeBrowserRequest extends Omit<
  agentcore.InvokeBrowserRequest,
  "browserIdentifier"
> {}

/**
 * Performs an OS-level browser action (mouse, keyboard, screenshot) in a session.
 *
 * OS-level actions cover interactions the Chrome DevTools Protocol cannot reach — print dialogs, context menus, and JavaScript alerts.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.InvokeBrowserHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Automation
 * @example Take a Screenshot
 * ```typescript
 * // init
 * const invokeBrowser = yield* AgentCore.InvokeBrowser(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* invokeBrowser({
 *       sessionId,
 *       action: { screenshot: {} },
 *     });
 *     return HttpServerResponse.json({ result: result.result });
 *   }),
 * };
 * ```
 */
export interface InvokeBrowser extends Binding.Service<
  InvokeBrowser,
  "AWS.BedrockAgentCore.InvokeBrowser",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: InvokeBrowserRequest,
    ) => Effect.Effect<
      agentcore.InvokeBrowserResponse,
      agentcore.InvokeBrowserError
    >
  >
> {}
export const InvokeBrowser = Binding.Service<InvokeBrowser>(
  "AWS.BedrockAgentCore.InvokeBrowser",
);
