import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeDatastoreHttpBinding } from "./BindingHttp.ts";
import { ListFHIRExportJobs } from "./ListFHIRExportJobs.ts";

export const ListFHIRExportJobsHttp = Layer.effect(
  ListFHIRExportJobs,
  makeHealthLakeDatastoreHttpBinding({
    tag: "AWS.HealthLake.ListFHIRExportJobs",
    operation: healthlake.listFHIRExportJobs,
    actions: ["healthlake:ListFHIRExportJobs"],
  }),
);
