import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:UpdateAccountPreferences`.
 *
 * Updates the account-level AWS Chatbot preferences (user-level
 * authorization requirement, training-data collection). Provide the
 * implementation with
 * `Effect.provide(AWS.Chatbot.UpdateAccountPreferencesHttp)`.
 * @binding
 * @section Account Preferences
 * @example Require user authorization account-wide
 * ```typescript
 * const updateAccountPreferences =
 *   yield* AWS.Chatbot.UpdateAccountPreferences();
 * yield* updateAccountPreferences({ UserAuthorizationRequired: true });
 * ```
 */
export interface UpdateAccountPreferences extends Binding.Service<
  UpdateAccountPreferences,
  "AWS.Chatbot.UpdateAccountPreferences",
  () => Effect.Effect<
    (
      request?: chatbot.UpdateAccountPreferencesRequest,
    ) => Effect.Effect<
      chatbot.UpdateAccountPreferencesResult,
      chatbot.UpdateAccountPreferencesError
    >
  >
> {}

export const UpdateAccountPreferences =
  Binding.Service<UpdateAccountPreferences>(
    "AWS.Chatbot.UpdateAccountPreferences",
  );
