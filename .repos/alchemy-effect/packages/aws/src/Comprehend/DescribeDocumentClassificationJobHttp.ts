import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeDocumentClassificationJob } from "./DescribeDocumentClassificationJob.ts";

export const DescribeDocumentClassificationJobHttp = Layer.effect(
  DescribeDocumentClassificationJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeDocumentClassificationJob",
    operation: comprehend.describeDocumentClassificationJob,
    actions: ["comprehend:DescribeDocumentClassificationJob"],
  }),
);
