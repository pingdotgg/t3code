import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";
import {
  ListAssetProperties,
  type ListAssetPropertiesRequest,
} from "./ListAssetProperties.ts";

export const ListAssetPropertiesHttp = Layer.effect(
  ListAssetProperties,
  makeSiteWiseAssetHttpBinding({
    capability: "ListAssetProperties",
    iamActions: ["iotsitewise:ListAssetProperties"],
    operation: sitewise.listAssetProperties,
    prepare: (request: ListAssetPropertiesRequest | undefined, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
