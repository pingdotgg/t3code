import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { StopFlow } from "./StopFlow.ts";

export const StopFlowHttp = Layer.effect(
  StopFlow,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.StopFlow",
    operation: mediaconnect.stopFlow,
    actions: ["mediaconnect:StopFlow"],
  }),
);
