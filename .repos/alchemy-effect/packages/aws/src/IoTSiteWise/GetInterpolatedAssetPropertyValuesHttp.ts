import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import {
  GetInterpolatedAssetPropertyValues,
  type GetInterpolatedAssetPropertyValuesRequest,
} from "./GetInterpolatedAssetPropertyValues.ts";

export const GetInterpolatedAssetPropertyValuesHttp = Layer.effect(
  GetInterpolatedAssetPropertyValues,
  makeSiteWiseAssetHttpBinding({
    capability: "GetInterpolatedAssetPropertyValues",
    iamActions: ["iotsitewise:GetInterpolatedAssetPropertyValues"],
    operation: sitewise.getInterpolatedAssetPropertyValues,
    prepare: (request: GetInterpolatedAssetPropertyValuesRequest, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
