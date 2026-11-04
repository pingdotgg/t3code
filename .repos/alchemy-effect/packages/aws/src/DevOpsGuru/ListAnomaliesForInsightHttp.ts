import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListAnomaliesForInsight } from "./ListAnomaliesForInsight.ts";

export const ListAnomaliesForInsightHttp = Layer.effect(
  ListAnomaliesForInsight,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListAnomaliesForInsight",
    operation: devopsguru.listAnomaliesForInsight,
    actions: ["devops-guru:ListAnomaliesForInsight"],
  }),
);
