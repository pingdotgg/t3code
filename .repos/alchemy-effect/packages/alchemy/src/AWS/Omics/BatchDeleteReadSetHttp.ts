import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteReadSet } from "./BatchDeleteReadSet.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const BatchDeleteReadSetHttp = Layer.effect(
  BatchDeleteReadSet,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.BatchDeleteReadSet",
    operation: omics.batchDeleteReadSet,
    actions: ["omics:BatchDeleteReadSet"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
