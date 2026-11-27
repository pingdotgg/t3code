import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListDocumentClassificationJobs } from "./ListDocumentClassificationJobs.ts";

export const ListDocumentClassificationJobsHttp = Layer.effect(
  ListDocumentClassificationJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListDocumentClassificationJobs",
    operation: comprehend.listDocumentClassificationJobs,
    actions: ["comprehend:ListDocumentClassificationJobs"],
  }),
);
