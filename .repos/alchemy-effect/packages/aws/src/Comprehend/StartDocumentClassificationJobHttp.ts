import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartDocumentClassificationJob } from "./StartDocumentClassificationJob.ts";

export const StartDocumentClassificationJobHttp = Layer.effect(
  StartDocumentClassificationJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartDocumentClassificationJob",
    operation: comprehend.startDocumentClassificationJob,
    actions: ["comprehend:StartDocumentClassificationJob"],
  }),
);
