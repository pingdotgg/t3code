import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.GetInstance",
    operation: SD.getInstance,
    actions: ["servicediscovery:GetInstance"],
  }),
);
