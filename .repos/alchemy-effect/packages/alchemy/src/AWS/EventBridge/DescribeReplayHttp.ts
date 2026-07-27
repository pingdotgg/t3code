import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeReplay } from "./DescribeReplay.ts";

/**
 * HTTP implementation of {@link DescribeReplay}. At deploy time it grants
 * `events:DescribeReplay` on the account's replays; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const DescribeReplayHttp = Layer.effect(
  DescribeReplay,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.DescribeReplay",
    operation: eventbridge.describeReplay,
    actions: ["events:DescribeReplay"],
    resources: ({ accountId, region }) => [
      `arn:aws:events:${region}:${accountId}:replay/*`,
    ],
  }),
);
