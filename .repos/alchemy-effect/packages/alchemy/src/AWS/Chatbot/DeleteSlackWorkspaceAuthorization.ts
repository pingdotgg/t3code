import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DeleteSlackWorkspaceAuthorization`.
 *
 * Revokes AWS Chatbot's authorization for an entire Slack workspace — the
 * drastic end of offboarding automation. Existing channel configurations
 * for the workspace stop working until it is re-authorized via the console
 * OAuth flow. Provide the implementation with
 * `Effect.provide(AWS.Chatbot.DeleteSlackWorkspaceAuthorizationHttp)`.
 * @binding
 * @section Slack Identity Management
 * @example Revoke a Slack workspace authorization
 * ```typescript
 * const deleteSlackWorkspaceAuthorization =
 *   yield* AWS.Chatbot.DeleteSlackWorkspaceAuthorization();
 * yield* deleteSlackWorkspaceAuthorization({ SlackTeamId: "T012ABCDEFG" });
 * ```
 */
export interface DeleteSlackWorkspaceAuthorization extends Binding.Service<
  DeleteSlackWorkspaceAuthorization,
  "AWS.Chatbot.DeleteSlackWorkspaceAuthorization",
  () => Effect.Effect<
    (
      request: chatbot.DeleteSlackWorkspaceAuthorizationRequest,
    ) => Effect.Effect<
      chatbot.DeleteSlackWorkspaceAuthorizationResult,
      chatbot.DeleteSlackWorkspaceAuthorizationError
    >
  >
> {}

export const DeleteSlackWorkspaceAuthorization =
  Binding.Service<DeleteSlackWorkspaceAuthorization>(
    "AWS.Chatbot.DeleteSlackWorkspaceAuthorization",
  );
