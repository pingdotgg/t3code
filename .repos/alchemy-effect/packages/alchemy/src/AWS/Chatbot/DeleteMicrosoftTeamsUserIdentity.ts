import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DeleteMicrosoftTeamsUserIdentity`.
 *
 * Unlinks a Microsoft Teams user identity from its AWS user identity — the
 * write half of identity offboarding automation. Provide the implementation
 * with `Effect.provide(AWS.Chatbot.DeleteMicrosoftTeamsUserIdentityHttp)`.
 * @binding
 * @section Microsoft Teams Identity Management
 * @example Unlink a Teams user identity
 * ```typescript
 * const deleteMicrosoftTeamsUserIdentity =
 *   yield* AWS.Chatbot.DeleteMicrosoftTeamsUserIdentity();
 * yield* deleteMicrosoftTeamsUserIdentity({
 *   ChatConfigurationArn: configurationArn,
 *   UserId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
 * });
 * ```
 */
export interface DeleteMicrosoftTeamsUserIdentity extends Binding.Service<
  DeleteMicrosoftTeamsUserIdentity,
  "AWS.Chatbot.DeleteMicrosoftTeamsUserIdentity",
  () => Effect.Effect<
    (
      request: chatbot.DeleteMicrosoftTeamsUserIdentityRequest,
    ) => Effect.Effect<
      chatbot.DeleteMicrosoftTeamsUserIdentityResult,
      chatbot.DeleteMicrosoftTeamsUserIdentityError
    >
  >
> {}

export const DeleteMicrosoftTeamsUserIdentity =
  Binding.Service<DeleteMicrosoftTeamsUserIdentity>(
    "AWS.Chatbot.DeleteMicrosoftTeamsUserIdentity",
  );
