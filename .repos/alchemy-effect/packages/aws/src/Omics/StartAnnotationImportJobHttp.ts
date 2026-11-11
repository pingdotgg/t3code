import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartAnnotationImportJob } from "./StartAnnotationImportJob.ts";

export const StartAnnotationImportJobHttp = Layer.effect(
  StartAnnotationImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartAnnotationImportJob",
    operation: omics.startAnnotationImportJob,
    actions: ["omics:StartAnnotationImportJob"],
    key: "destinationName",
    id: (store) => store.name,
    arn: (store) => store.annotationStoreArn,
    passRole: true,
  }),
);
