import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReferences } from "./ListReferences.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const ListReferencesHttp = Layer.effect(
  ListReferences,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReferences",
    operation: omics.listReferences,
    actions: ["omics:ListReferences"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
