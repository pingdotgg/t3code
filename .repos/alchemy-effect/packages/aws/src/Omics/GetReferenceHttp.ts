import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReference } from "./GetReference.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const GetReferenceHttp = Layer.effect(
  GetReference,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReference",
    operation: omics.getReference,
    actions: ["omics:GetReference"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
