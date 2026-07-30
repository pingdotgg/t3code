import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeStartJobHttpBinding } from "./BindingHttp.ts";
import { StartFHIRImportJob } from "./StartFHIRImportJob.ts";

export const StartFHIRImportJobHttp = Layer.effect(
  StartFHIRImportJob,
  makeHealthLakeStartJobHttpBinding({
    tag: "AWS.HealthLake.StartFHIRImportJob",
    operation: healthlake.startFHIRImportJob,
    actions: ["healthlake:StartFHIRImportJob"],
  }),
);
