import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassComponentHttpBinding } from "./BindingHttp.ts";
import { GetComponent } from "./GetComponent.ts";

export const GetComponentHttp = Layer.effect(
  GetComponent,
  makeGreengrassComponentHttpBinding({
    tag: "AWS.GreengrassV2.GetComponent",
    operation: greengrassv2.getComponent,
    actions: ["greengrass:GetComponent"],
  }),
);
