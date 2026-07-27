import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationMapHttpBinding } from "./BindingHttp.ts";
import { GetMapTile } from "./GetMapTile.ts";

export const GetMapTileHttp = Layer.effect(
  GetMapTile,
  makeLocationMapHttpBinding({
    tag: "AWS.Location.GetMapTile",
    operation: location.getMapTile,
    actions: ["geo:GetMapTile"],
  }),
);
