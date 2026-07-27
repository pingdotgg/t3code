import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DeleteSlackUserIdentity`.
 *
 * Unlinks a Slack user identity from its AWS user identity — the write half
 * of identity offboarding automation (e.g. revoke a departing employee's
 * chat identity from a Lambda triggered by your HR system). Provide the
 * implementation with
 * `Effect.provide(AWS.Chatbot.DeleteSlackUserIdentityHttp)`.
 * @binding
 * @section Slack Identity Management
 * @example Unlink a Slack user identity
 * ```typescript
 * const deleteSlackUserIdentity =
 *   yield* AWS.Chatbot.DeleteSlackUserIdentity();
 * yield* deleteSlackUserIdentity({
 *   ChatConfigurationArn: configurationArn,
 *   SlackTeamId: "T012ABCDEFG",
 *   SlackUserId: "U012AB3CD",
 * });
 * ```
 */
export interface DeleteSlackUserIdentity extends Binding.Service<
  DeleteSlackUserIdentity,
  "AWS.Chatbot.DeleteSlackUserIdentity",
  () => Effect.Effect<
    (
      request: chatbot.DeleteSlackUserIdentityRequest,
    ) => Effect.Effect<
      chatbot.DeleteSlackUserIdentityResult,
      chatbot.DeleteSlackUserIdentityError
    >
  >
> {}

export const DeleteSlackUserIdentity = Binding.Service<DeleteSlackUserIdentity>(
  "AWS.Chatbot.DeleteSlackUserIdentity",
);
