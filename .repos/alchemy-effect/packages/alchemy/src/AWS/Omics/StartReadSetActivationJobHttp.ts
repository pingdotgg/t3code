import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartReadSetActivationJob } from "./StartReadSetActivationJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const StartReadSetActivationJobHttp = Layer.effect(
  StartReadSetActivationJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartReadSetActivationJob",
    operation: omics.startReadSetActivationJob,
    actions: ["omics:StartReadSetActivationJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
