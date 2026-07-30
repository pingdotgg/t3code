import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeDatastoreHttpBinding } from "./BindingHttp.ts";
import { DescribeFHIRExportJob } from "./DescribeFHIRExportJob.ts";

export const DescribeFHIRExportJobHttp = Layer.effect(
  DescribeFHIRExportJob,
  makeHealthLakeDatastoreHttpBinding({
    tag: "AWS.HealthLake.DescribeFHIRExportJob",
    operation: healthlake.describeFHIRExportJob,
    actions: ["healthlake:DescribeFHIRExportJob"],
  }),
);
