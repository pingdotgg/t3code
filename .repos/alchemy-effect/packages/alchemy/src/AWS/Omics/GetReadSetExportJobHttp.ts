import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReadSetExportJob } from "./GetReadSetExportJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const GetReadSetExportJobHttp = Layer.effect(
  GetReadSetExportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSetExportJob",
    operation: omics.getReadSetExportJob,
    actions: ["omics:GetReadSetExportJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
