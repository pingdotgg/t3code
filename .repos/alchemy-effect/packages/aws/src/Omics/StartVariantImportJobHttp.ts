import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartVariantImportJob } from "./StartVariantImportJob.ts";

export const StartVariantImportJobHttp = Layer.effect(
  StartVariantImportJob,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartVariantImportJob",
    operation: omics.startVariantImportJob,
    actions: ["omics:StartVariantImportJob"],
    key: "destinationName",
    id: (store) => store.name,
    arn: (store) => store.variantStoreArn,
    passRole: true,
  }),
);
