import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeFeedback } from "./DescribeFeedback.ts";

export const DescribeFeedbackHttp = Layer.effect(
  DescribeFeedback,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeFeedback",
    operation: devopsguru.describeFeedback,
    actions: ["devops-guru:DescribeFeedback"],
  }),
);
