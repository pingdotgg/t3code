import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding, revisionAssetArns } from "./BindingHttp.ts";
import { UpdateAsset } from "./UpdateAsset.ts";

export const UpdateAssetHttp = Layer.effect(
  UpdateAsset,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.UpdateAsset",
    operation: dataexchange.updateAsset,
    actions: ["dataexchange:UpdateAsset"],
    resources: revisionAssetArns,
  }),
);
