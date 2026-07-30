import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeDatastoreHttpBinding } from "./BindingHttp.ts";
import { DescribeFHIRImportJob } from "./DescribeFHIRImportJob.ts";

export const DescribeFHIRImportJobHttp = Layer.effect(
  DescribeFHIRImportJob,
  makeHealthLakeDatastoreHttpBinding({
    tag: "AWS.HealthLake.DescribeFHIRImportJob",
    operation: healthlake.describeFHIRImportJob,
    actions: ["healthlake:DescribeFHIRImportJob"],
  }),
);
