import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartReadSetImportJob } from "./StartReadSetImportJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const StartReadSetImportJobHttp = Layer.effect(
  StartReadSetImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartReadSetImportJob",
    operation: omics.startReadSetImportJob,
    actions: ["omics:StartReadSetImportJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
    passRole: true,
  }),
);
