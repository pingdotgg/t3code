import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import {
  GetAssetPropertyAggregates,
  type GetAssetPropertyAggregatesRequest,
} from "./GetAssetPropertyAggregates.ts";

export const GetAssetPropertyAggregatesHttp = Layer.effect(
  GetAssetPropertyAggregates,
  makeSiteWiseAssetHttpBinding({
    capability: "GetAssetPropertyAggregates",
    iamActions: ["iotsitewise:GetAssetPropertyAggregates"],
    operation: sitewise.getAssetPropertyAggregates,
    prepare: (request: GetAssetPropertyAggregatesRequest, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
