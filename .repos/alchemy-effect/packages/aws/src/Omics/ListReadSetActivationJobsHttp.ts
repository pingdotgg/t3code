import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReadSetActivationJobs } from "./ListReadSetActivationJobs.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const ListReadSetActivationJobsHttp = Layer.effect(
  ListReadSetActivationJobs,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReadSetActivationJobs",
    operation: omics.listReadSetActivationJobs,
    actions: ["omics:ListReadSetActivationJobs"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
