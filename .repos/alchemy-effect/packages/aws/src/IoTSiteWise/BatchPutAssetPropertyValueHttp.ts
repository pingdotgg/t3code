import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Layer from "effect/Layer";
import {
  BatchPutAssetPropertyValue,
  type BatchPutAssetPropertyValueRequest,
} from "./BatchPutAssetPropertyValue.ts";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";

export const BatchPutAssetPropertyValueHttp = Layer.effect(
  BatchPutAssetPropertyValue,
  makeSiteWiseAssetHttpBinding({
    capability: "BatchPutAssetPropertyValue",
    iamActions: ["iotsitewise:BatchPutAssetPropertyValue"],
    operation: sitewise.batchPutAssetPropertyValue,
    // Inject the bound asset's id into every entry that does not target a
    // data stream by alias.
    prepare: (request: BatchPutAssetPropertyValueRequest, assetId) => ({
      ...request,
      entries: request.entries.map((entry) =>
        entry.propertyAlias === undefined ? { ...entry, assetId } : entry,
      ),
    }),
  }),
);
