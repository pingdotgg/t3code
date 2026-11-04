import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as Layer from "effect/Layer";
import { makeHealthLakeDatastoreHttpBinding } from "./BindingHttp.ts";
import { ListFHIRImportJobs } from "./ListFHIRImportJobs.ts";

export const ListFHIRImportJobsHttp = Layer.effect(
  ListFHIRImportJobs,
  makeHealthLakeDatastoreHttpBinding({
    tag: "AWS.HealthLake.ListFHIRImportJobs",
    operation: healthlake.listFHIRImportJobs,
    actions: ["healthlake:ListFHIRImportJobs"],
  }),
);
