import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartReadSetExportJob } from "./StartReadSetExportJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const StartReadSetExportJobHttp = Layer.effect(
  StartReadSetExportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartReadSetExportJob",
    operation: omics.startReadSetExportJob,
    actions: ["omics:StartReadSetExportJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
    passRole: true,
  }),
);
