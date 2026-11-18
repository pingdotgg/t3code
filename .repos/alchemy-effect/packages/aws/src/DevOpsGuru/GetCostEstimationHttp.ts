import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { GetCostEstimation } from "./GetCostEstimation.ts";

export const GetCostEstimationHttp = Layer.effect(
  GetCostEstimation,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.GetCostEstimation",
    operation: devopsguru.getCostEstimation,
    actions: ["devops-guru:GetCostEstimation"],
  }),
);
