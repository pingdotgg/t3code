import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationMapHttpBinding } from "./BindingHttp.ts";
import { GetMapSprites } from "./GetMapSprites.ts";

export const GetMapSpritesHttp = Layer.effect(
  GetMapSprites,
  makeLocationMapHttpBinding({
    tag: "AWS.Location.GetMapSprites",
    operation: location.getMapSprites,
    actions: ["geo:GetMapSprites"],
  }),
);
