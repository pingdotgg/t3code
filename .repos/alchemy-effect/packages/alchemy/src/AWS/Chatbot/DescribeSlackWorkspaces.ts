import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DescribeSlackWorkspaces`.
 *
 * Lists the Slack workspaces authorized with AWS Chatbot in the account —
 * useful for identity/workspace audit automation. Provide the
 * implementation with
 * `Effect.provide(AWS.Chatbot.DescribeSlackWorkspacesHttp)`.
 * @binding
 * @section Slack Identity Management
 * @example List authorized Slack workspaces
 * ```typescript
 * const describeSlackWorkspaces =
 *   yield* AWS.Chatbot.DescribeSlackWorkspaces();
 * const result = yield* describeSlackWorkspaces();
 * const teamIds = (result.SlackWorkspaces ?? []).map((w) => w.SlackTeamId);
 * ```
 */
export interface DescribeSlackWorkspaces extends Binding.Service<
  DescribeSlackWorkspaces,
  "AWS.Chatbot.DescribeSlackWorkspaces",
  () => Effect.Effect<
    (
      request?: chatbot.DescribeSlackWorkspacesRequest,
    ) => Effect.Effect<
      chatbot.DescribeSlackWorkspacesResult,
      chatbot.DescribeSlackWorkspacesError
    >
  >
> {}

export const DescribeSlackWorkspaces = Binding.Service<DescribeSlackWorkspaces>(
  "AWS.Chatbot.DescribeSlackWorkspaces",
);
