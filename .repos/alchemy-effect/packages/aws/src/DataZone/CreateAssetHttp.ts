import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { CreateAsset } from "./CreateAsset.ts";

export const CreateAssetHttp = Layer.effect(
  CreateAsset,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.CreateAsset",
    operation: datazone.createAsset,
    actions: ["datazone:CreateAsset"],
  }),
);
