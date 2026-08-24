import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:ListMicrosoftTeamsConfiguredTeams`.
 *
 * Lists the Microsoft Teams teams onboarded to AWS Chatbot in the account —
 * useful for identity/team audit automation. Provide the implementation
 * with `Effect.provide(AWS.Chatbot.ListMicrosoftTeamsConfiguredTeamsHttp)`.
 * @binding
 * @section Microsoft Teams Identity Management
 * @example List configured Microsoft Teams teams
 * ```typescript
 * const listMicrosoftTeamsConfiguredTeams =
 *   yield* AWS.Chatbot.ListMicrosoftTeamsConfiguredTeams();
 * const result = yield* listMicrosoftTeamsConfiguredTeams();
 * const teamIds = (result.ConfiguredTeams ?? []).map((t) => t.TeamId);
 * ```
 */
export interface ListMicrosoftTeamsConfiguredTeams extends Binding.Service<
  ListMicrosoftTeamsConfiguredTeams,
  "AWS.Chatbot.ListMicrosoftTeamsConfiguredTeams",
  () => Effect.Effect<
    (
      request?: chatbot.ListMicrosoftTeamsConfiguredTeamsRequest,
    ) => Effect.Effect<
      chatbot.ListMicrosoftTeamsConfiguredTeamsResult,
      chatbot.ListMicrosoftTeamsConfiguredTeamsError
    >
  >
> {}

export const ListMicrosoftTeamsConfiguredTeams =
  Binding.Service<ListMicrosoftTeamsConfiguredTeams>(
    "AWS.Chatbot.ListMicrosoftTeamsConfiguredTeams",
  );
