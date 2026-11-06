import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReadSetMetadata } from "./GetReadSetMetadata.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const GetReadSetMetadataHttp = Layer.effect(
  GetReadSetMetadata,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSetMetadata",
    operation: omics.getReadSetMetadata,
    actions: ["omics:GetReadSetMetadata"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
