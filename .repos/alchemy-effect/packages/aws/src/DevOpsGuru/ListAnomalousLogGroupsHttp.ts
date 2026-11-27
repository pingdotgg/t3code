import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListAnomalousLogGroups } from "./ListAnomalousLogGroups.ts";

export const ListAnomalousLogGroupsHttp = Layer.effect(
  ListAnomalousLogGroups,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListAnomalousLogGroups",
    operation: devopsguru.listAnomalousLogGroups,
    actions: ["devops-guru:ListAnomalousLogGroups"],
  }),
);
