import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReadSetImportJobs } from "./ListReadSetImportJobs.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const ListReadSetImportJobsHttp = Layer.effect(
  ListReadSetImportJobs,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReadSetImportJobs",
    operation: omics.listReadSetImportJobs,
    actions: ["omics:ListReadSetImportJobs"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
