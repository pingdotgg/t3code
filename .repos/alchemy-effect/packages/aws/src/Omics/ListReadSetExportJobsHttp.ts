import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReadSetExportJobs } from "./ListReadSetExportJobs.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export const ListReadSetExportJobsHttp = Layer.effect(
  ListReadSetExportJobs,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReadSetExportJobs",
    operation: omics.listReadSetExportJobs,
    actions: ["omics:ListReadSetExportJobs"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
