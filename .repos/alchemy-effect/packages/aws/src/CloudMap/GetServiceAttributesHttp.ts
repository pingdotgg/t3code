import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { GetServiceAttributes } from "./GetServiceAttributes.ts";

export const GetServiceAttributesHttp = Layer.effect(
  GetServiceAttributes,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.GetServiceAttributes",
    operation: SD.getServiceAttributes,
    actions: ["servicediscovery:GetServiceAttributes"],
  }),
);
