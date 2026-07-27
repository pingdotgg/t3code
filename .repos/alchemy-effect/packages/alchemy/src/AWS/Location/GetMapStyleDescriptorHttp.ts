import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationMapHttpBinding } from "./BindingHttp.ts";
import { GetMapStyleDescriptor } from "./GetMapStyleDescriptor.ts";

export const GetMapStyleDescriptorHttp = Layer.effect(
  GetMapStyleDescriptor,
  makeLocationMapHttpBinding({
    tag: "AWS.Location.GetMapStyleDescriptor",
    operation: location.getMapStyleDescriptor,
    actions: ["geo:GetMapStyleDescriptor"],
  }),
);
