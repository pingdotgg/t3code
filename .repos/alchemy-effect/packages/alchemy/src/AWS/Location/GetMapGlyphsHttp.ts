import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationMapHttpBinding } from "./BindingHttp.ts";
import { GetMapGlyphs } from "./GetMapGlyphs.ts";

export const GetMapGlyphsHttp = Layer.effect(
  GetMapGlyphs,
  makeLocationMapHttpBinding({
    tag: "AWS.Location.GetMapGlyphs",
    operation: location.getMapGlyphs,
    actions: ["geo:GetMapGlyphs"],
  }),
);
