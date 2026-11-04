import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReferenceMetadata } from "./GetReferenceMetadata.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const GetReferenceMetadataHttp = Layer.effect(
  GetReferenceMetadata,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReferenceMetadata",
    operation: omics.getReferenceMetadata,
    actions: ["omics:GetReferenceMetadata"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
