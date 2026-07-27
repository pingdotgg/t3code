import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DeleteMicrosoftTeamsConfiguredTeam`.
 *
 * Removes an onboarded Microsoft Teams team from AWS Chatbot — the drastic
 * end of offboarding automation. Existing channel configurations for the
 * team stop working until it is re-onboarded via the console OAuth flow.
 * Provide the implementation with
 * `Effect.provide(AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeamHttp)`.
 * @binding
 * @section Microsoft Teams Identity Management
 * @example Offboard a Microsoft Teams team
 * ```typescript
 * const deleteMicrosoftTeamsConfiguredTeam =
 *   yield* AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeam();
 * yield* deleteMicrosoftTeamsConfiguredTeam({
 *   TeamId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
 * });
 * ```
 */
export interface DeleteMicrosoftTeamsConfiguredTeam extends Binding.Service<
  DeleteMicrosoftTeamsConfiguredTeam,
  "AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeam",
  () => Effect.Effect<
    (
      request: chatbot.DeleteTeamsConfiguredTeamRequest,
    ) => Effect.Effect<
      chatbot.DeleteTeamsConfiguredTeamResult,
      chatbot.DeleteMicrosoftTeamsConfiguredTeamError
    >
  >
> {}

export const DeleteMicrosoftTeamsConfiguredTeam =
  Binding.Service<DeleteMicrosoftTeamsConfiguredTeam>(
    "AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeam",
  );
