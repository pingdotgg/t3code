import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { PutFeedback } from "./PutFeedback.ts";

export const PutFeedbackHttp = Layer.effect(
  PutFeedback,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.PutFeedback",
    operation: devopsguru.putFeedback,
    actions: ["devops-guru:PutFeedback"],
  }),
);
