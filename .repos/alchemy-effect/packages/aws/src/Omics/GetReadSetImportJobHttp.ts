import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReadSetImportJob } from "./GetReadSetImportJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const GetReadSetImportJobHttp = Layer.effect(
  GetReadSetImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSetImportJob",
    operation: omics.getReadSetImportJob,
    actions: ["omics:GetReadSetImportJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
