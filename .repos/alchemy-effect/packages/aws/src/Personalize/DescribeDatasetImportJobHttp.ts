import * as personalize from "@distilled.cloud/aws/personalize";
import * as Layer from "effect/Layer";
import { makePersonalizeAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDatasetImportJob } from "./DescribeDatasetImportJob.ts";

export const DescribeDatasetImportJobHttp = Layer.effect(
  DescribeDatasetImportJob,
  makePersonalizeAccountHttpBinding({
    tag: "AWS.Personalize.DescribeDatasetImportJob",
    operation: personalize.describeDatasetImportJob,
    actions: ["personalize:DescribeDatasetImportJob"],
  }),
);
