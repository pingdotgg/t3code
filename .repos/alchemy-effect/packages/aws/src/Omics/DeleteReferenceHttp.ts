import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { DeleteReference } from "./DeleteReference.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const DeleteReferenceHttp = Layer.effect(
  DeleteReference,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.DeleteReference",
    operation: omics.deleteReference,
    actions: ["omics:DeleteReference"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
