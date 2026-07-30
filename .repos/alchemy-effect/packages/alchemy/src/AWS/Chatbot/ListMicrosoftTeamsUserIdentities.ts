import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:ListMicrosoftTeamsUserIdentities`.
 *
 * Lists the Microsoft Teams user identities linked to AWS user identities,
 * optionally filtered to one channel configuration — the read half of
 * identity offboarding automation. Provide the implementation with
 * `Effect.provide(AWS.Chatbot.ListMicrosoftTeamsUserIdentitiesHttp)`.
 * @binding
 * @section Microsoft Teams Identity Management
 * @example List linked Teams user identities
 * ```typescript
 * const listMicrosoftTeamsUserIdentities =
 *   yield* AWS.Chatbot.ListMicrosoftTeamsUserIdentities();
 * const result = yield* listMicrosoftTeamsUserIdentities();
 * const users = (result.TeamsUserIdentities ?? []).map((u) => u.UserId);
 * ```
 */
export interface ListMicrosoftTeamsUserIdentities extends Binding.Service<
  ListMicrosoftTeamsUserIdentities,
  "AWS.Chatbot.ListMicrosoftTeamsUserIdentities",
  () => Effect.Effect<
    (
      request?: chatbot.ListMicrosoftTeamsUserIdentitiesRequest,
    ) => Effect.Effect<
      chatbot.ListMicrosoftTeamsUserIdentitiesResult,
      chatbot.ListMicrosoftTeamsUserIdentitiesError
    >
  >
> {}

export const ListMicrosoftTeamsUserIdentities =
  Binding.Service<ListMicrosoftTeamsUserIdentities>(
    "AWS.Chatbot.ListMicrosoftTeamsUserIdentities",
  );
