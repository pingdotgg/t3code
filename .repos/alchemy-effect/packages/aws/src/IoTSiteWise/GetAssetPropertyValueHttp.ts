import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import {
  GetAssetPropertyValue,
  type GetAssetPropertyValueRequest,
} from "./GetAssetPropertyValue.ts";

export const GetAssetPropertyValueHttp = Layer.effect(
  GetAssetPropertyValue,
  makeSiteWiseAssetHttpBinding({
    capability: "GetAssetPropertyValue",
    iamActions: ["iotsitewise:GetAssetPropertyValue"],
    operation: sitewise.getAssetPropertyValue,
    prepare: (request: GetAssetPropertyValueRequest, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
