import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteInsight } from "./DeleteInsight.ts";

export const DeleteInsightHttp = Layer.effect(
  DeleteInsight,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DeleteInsight",
    operation: devopsguru.deleteInsight,
    actions: ["devops-guru:DeleteInsight"],
  }),
);
