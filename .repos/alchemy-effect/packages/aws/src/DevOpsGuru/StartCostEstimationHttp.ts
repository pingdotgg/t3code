import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { StartCostEstimation } from "./StartCostEstimation.ts";

export const StartCostEstimationHttp = Layer.effect(
  StartCostEstimation,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.StartCostEstimation",
    operation: devopsguru.startCostEstimation,
    actions: ["devops-guru:StartCostEstimation"],
  }),
);
