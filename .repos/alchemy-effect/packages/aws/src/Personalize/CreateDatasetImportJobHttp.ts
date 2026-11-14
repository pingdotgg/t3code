import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateDatasetImportJob } from "./CreateDatasetImportJob.ts";

export const CreateDatasetImportJobHttp = Layer.effect(
  CreateDatasetImportJob,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.CreateDatasetImportJob",
    operation: personalize.createDatasetImportJob,
    actions: ["personalize:CreateDatasetImportJob"],
    passRole: true,
  }),
);
