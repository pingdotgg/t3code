import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeStartJobHttpBinding } from "./BindingHttp.ts";
import { StartFHIRExportJob } from "./StartFHIRExportJob.ts";

export const StartFHIRExportJobHttp = Layer.effect(
  StartFHIRExportJob,
  makeHealthLakeStartJobHttpBinding({
    tag: "AWS.HealthLake.StartFHIRExportJob",
    operation: healthlake.startFHIRExportJob,
    actions: ["healthlake:StartFHIRExportJob"],
  }),
);
