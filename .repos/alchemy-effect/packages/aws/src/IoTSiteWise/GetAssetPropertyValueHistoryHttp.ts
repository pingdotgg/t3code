import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import {
  GetAssetPropertyValueHistory,
  type GetAssetPropertyValueHistoryRequest,
} from "./GetAssetPropertyValueHistory.ts";

export const GetAssetPropertyValueHistoryHttp = Layer.effect(
  GetAssetPropertyValueHistory,
  makeSiteWiseAssetHttpBinding({
    capability: "GetAssetPropertyValueHistory",
    iamActions: ["iotsitewise:GetAssetPropertyValueHistory"],
    operation: sitewise.getAssetPropertyValueHistory,
    prepare: (request: GetAssetPropertyValueHistoryRequest, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
