import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface ListBrowserSessionsRequest extends Omit<
  agentcore.ListBrowserSessionsRequest,
  "browserIdentifier"
> {}

/**
 * Lists the browser's sessions.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListBrowserSessionsHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Sessions
 * @example List Sessions
 * ```typescript
 * // init
 * const listBrowserSessions = yield* AgentCore.ListBrowserSessions(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listBrowserSessions({});
 *     return HttpServerResponse.json({ count: result.items?.length ?? 0 });
 *   }),
 * };
 * ```
 */
export interface ListBrowserSessions extends Binding.Service<
  ListBrowserSessions,
  "AWS.BedrockAgentCore.ListBrowserSessions",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: ListBrowserSessionsRequest,
    ) => Effect.Effect<
      agentcore.ListBrowserSessionsResponse,
      agentcore.ListBrowserSessionsError
    >
  >
> {}
export const ListBrowserSessions = Binding.Service<ListBrowserSessions>(
  "AWS.BedrockAgentCore.ListBrowserSessions",
);
