import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReadSet } from "./GetReadSet.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const GetReadSetHttp = Layer.effect(
  GetReadSet,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSet",
    operation: omics.getReadSet,
    actions: ["omics:GetReadSet"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
