import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding, revisionAssetArns } from "./BindingHttp.ts";
import { DeleteAsset } from "./DeleteAsset.ts";

export const DeleteAssetHttp = Layer.effect(
  DeleteAsset,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.DeleteAsset",
    operation: dataexchange.deleteAsset,
    actions: ["dataexchange:DeleteAsset"],
    resources: revisionAssetArns,
  }),
);
