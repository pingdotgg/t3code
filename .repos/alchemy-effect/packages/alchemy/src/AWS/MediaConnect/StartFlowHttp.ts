import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { StartFlow } from "./StartFlow.ts";

export const StartFlowHttp = Layer.effect(
  StartFlow,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.StartFlow",
    operation: mediaconnect.startFlow,
    actions: ["mediaconnect:StartFlow"],
  }),
);
