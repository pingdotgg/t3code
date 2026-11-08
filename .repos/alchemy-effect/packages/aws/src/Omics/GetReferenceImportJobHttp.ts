import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { GetReferenceImportJob } from "./GetReferenceImportJob.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export const GetReferenceImportJobHttp = Layer.effect(
  GetReferenceImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReferenceImportJob",
    operation: omics.getReferenceImportJob,
    actions: ["omics:GetReferenceImportJob"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
