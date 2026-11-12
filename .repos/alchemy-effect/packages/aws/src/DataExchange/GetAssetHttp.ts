import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding, revisionAssetArns } from "./BindingHttp.ts";
import { GetAsset } from "./GetAsset.ts";

export const GetAssetHttp = Layer.effect(
  GetAsset,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.GetAsset",
    operation: dataexchange.getAsset,
    actions: ["dataexchange:GetAsset"],
    resources: revisionAssetArns,
  }),
);
