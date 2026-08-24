import type * as chatbot from "@distilled.cloud/aws/chatbot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `chatbot:DescribeSlackUserIdentities`.
 *
 * Lists the Slack user identities linked to AWS user identities, optionally
 * filtered to one channel configuration — the read half of identity
 * offboarding automation. Provide the implementation with
 * `Effect.provide(AWS.Chatbot.DescribeSlackUserIdentitiesHttp)`.
 * @binding
 * @section Slack Identity Management
 * @example List linked Slack user identities
 * ```typescript
 * const describeSlackUserIdentities =
 *   yield* AWS.Chatbot.DescribeSlackUserIdentities();
 * const result = yield* describeSlackUserIdentities();
 * const users = (result.SlackUserIdentities ?? []).map((u) => u.SlackUserId);
 * ```
 */
export interface DescribeSlackUserIdentities extends Binding.Service<
  DescribeSlackUserIdentities,
  "AWS.Chatbot.DescribeSlackUserIdentities",
  () => Effect.Effect<
    (
      request?: chatbot.DescribeSlackUserIdentitiesRequest,
    ) => Effect.Effect<
      chatbot.DescribeSlackUserIdentitiesResult,
      chatbot.DescribeSlackUserIdentitiesError
    >
  >
> {}

export const DescribeSlackUserIdentities =
  Binding.Service<DescribeSlackUserIdentities>(
    "AWS.Chatbot.DescribeSlackUserIdentities",
  );
