import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";
import { ListReplays } from "./ListReplays.ts";

/**
 * HTTP implementation of {@link ListReplays}. At deploy time it grants
 * `events:ListReplays` (the action does not support resource-level
 * permissions); at runtime it calls the EventBridge API with the host
 * Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListReplaysHttp = Layer.effect(
  ListReplays,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.ListReplays",
    operation: eventbridge.listReplays,
    actions: ["events:ListReplays"],
  }),
);
