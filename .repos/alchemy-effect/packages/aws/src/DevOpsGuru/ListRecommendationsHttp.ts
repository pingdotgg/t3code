import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListRecommendations } from "./ListRecommendations.ts";

export const ListRecommendationsHttp = Layer.effect(
  ListRecommendations,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListRecommendations",
    operation: devopsguru.listRecommendations,
    actions: ["devops-guru:ListRecommendations"],
  }),
);
