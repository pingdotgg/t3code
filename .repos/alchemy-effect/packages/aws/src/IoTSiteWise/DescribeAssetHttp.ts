import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import { DescribeAsset, type DescribeAssetRequest } from "./DescribeAsset.ts";

export const DescribeAssetHttp = Layer.effect(
  DescribeAsset,
  makeSiteWiseAssetHttpBinding({
    capability: "DescribeAsset",
    iamActions: ["iotsitewise:DescribeAsset"],
    operation: sitewise.describeAsset,
    prepare: (request: DescribeAssetRequest | undefined, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
