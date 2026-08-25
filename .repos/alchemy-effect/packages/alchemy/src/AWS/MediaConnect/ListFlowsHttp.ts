import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectAccountHttpBinding } from "./BindingHttp.ts";
import { ListFlows } from "./ListFlows.ts";

export const ListFlowsHttp = Layer.effect(
  ListFlows,
  makeMediaConnectAccountHttpBinding({
    tag: "AWS.MediaConnect.ListFlows",
    operation: mediaconnect.listFlows,
    actions: ["mediaconnect:ListFlows"],
  }),
);
