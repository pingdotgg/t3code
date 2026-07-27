import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataSetHttpBinding, dataSetAssetArns } from "./BindingHttp.ts";
import { SendApiAsset } from "./SendApiAsset.ts";

export const SendApiAssetHttp = Layer.effect(
  SendApiAsset,
  makeDataSetHttpBinding({
    tag: "AWS.DataExchange.SendApiAsset",
    operation: dataexchange.sendApiAsset,
    actions: ["dataexchange:SendApiAsset"],
    resources: dataSetAssetArns,
  }),
);
