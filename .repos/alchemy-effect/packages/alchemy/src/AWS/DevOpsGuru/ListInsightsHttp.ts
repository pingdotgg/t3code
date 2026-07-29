import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListInsights } from "./ListInsights.ts";

export const ListInsightsHttp = Layer.effect(
  ListInsights,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListInsights",
    operation: devopsguru.listInsights,
    actions: ["devops-guru:ListInsights"],
  }),
);
