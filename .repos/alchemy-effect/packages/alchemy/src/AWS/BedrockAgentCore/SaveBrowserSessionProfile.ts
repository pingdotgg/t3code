import type * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface SaveBrowserSessionProfileRequest extends Omit<
  agentcore.SaveBrowserSessionProfileRequest,
  "browserIdentifier"
> {}

/**
 * Persists a browser session's state to a reusable browser profile.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.SaveBrowserSessionProfileHttp`
 * on the Function effect to implement the binding.
 *
 * @binding
 * @section Browser Profiles
 * @example Save a Session Profile
 * ```typescript
 * // init
 * const saveBrowserSessionProfile = yield* AgentCore.SaveBrowserSessionProfile(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* saveBrowserSessionProfile({
 *       sessionId,
 *       profileIdentifier,
 *     });
 *     return HttpServerResponse.json({ saved: true });
 *   }),
 * };
 * ```
 */
export interface SaveBrowserSessionProfile extends Binding.Service<
  SaveBrowserSessionProfile,
  "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: SaveBrowserSessionProfileRequest,
    ) => Effect.Effect<
      agentcore.SaveBrowserSessionProfileResponse,
      agentcore.SaveBrowserSessionProfileError
    >
  >
> {}
export const SaveBrowserSessionProfile =
  Binding.Service<SaveBrowserSessionProfile>(
    "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
  );
