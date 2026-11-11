import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";
import { StartReferenceImportJob } from "./StartReferenceImportJob.ts";

export const StartReferenceImportJobHttp = Layer.effect(
  StartReferenceImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartReferenceImportJob",
    operation: omics.startReferenceImportJob,
    actions: ["omics:StartReferenceImportJob"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
    passRole: true,
  }),
);
