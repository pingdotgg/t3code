import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:GetAccountPreferences`.
 *
 * Returns the account-level AWS Chatbot preferences (whether user-level
 * authorization is required and whether training-data collection is
 * enabled). Provide the implementation with
 * `Effect.provide(AWS.Chatbot.GetAccountPreferencesHttp)`.
 * @binding
 * @section Account Preferences
 * @example Read the account preferences
 * ```typescript
 * const getAccountPreferences = yield* AWS.Chatbot.GetAccountPreferences();
 * const result = yield* getAccountPreferences();
 * const trainingData = result.AccountPreferences?.TrainingDataCollectionEnabled;
 * ```
 */
export interface GetAccountPreferences extends Binding.Service<
  GetAccountPreferences,
  "AWS.Chatbot.GetAccountPreferences",
  () => Effect.Effect<
    (
      request?: chatbot.GetAccountPreferencesRequest,
    ) => Effect.Effect<
      chatbot.GetAccountPreferencesResult,
      chatbot.GetAccountPreferencesError
    >
  >
> {}

export const GetAccountPreferences = Binding.Service<GetAccountPreferences>(
  "AWS.Chatbot.GetAccountPreferences",
);
