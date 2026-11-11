import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsEndpointHttpBinding } from "./BindingHttp.ts";
import { SetEndpointAttributes } from "./SetEndpointAttributes.ts";

export const SetEndpointAttributesHttp = Layer.effect(
  SetEndpointAttributes,
  makeSnsEndpointHttpBinding({
    tag: "AWS.SNS.SetEndpointAttributes",
    operation: sns.setEndpointAttributes,
    actions: ["sns:SetEndpointAttributes"],
  }),
);
