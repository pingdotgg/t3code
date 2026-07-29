import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReadSetActivationJob } from "./GetReadSetActivationJob.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const GetReadSetActivationJobHttp = Layer.effect(
  GetReadSetActivationJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSetActivationJob",
    operation: omics.getReadSetActivationJob,
    actions: ["omics:GetReadSetActivationJob"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
