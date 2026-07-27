import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { ListReferenceImportJobs } from "./ListReferenceImportJobs.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const ListReferenceImportJobsHttp = Layer.effect(
  ListReferenceImportJobs,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReferenceImportJobs",
    operation: omics.listReferenceImportJobs,
    actions: ["omics:ListReferenceImportJobs"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
