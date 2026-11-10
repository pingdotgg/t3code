import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetAsset } from "./GetAsset.ts";

export const GetAssetHttp = Layer.effect(
  GetAsset,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetAsset",
    operation: datazone.getAsset,
    actions: ["datazone:GetAsset"],
  }),
);
