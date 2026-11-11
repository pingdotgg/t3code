import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Layer from "effect/Layer";
import { makeResourceGroupsAccountHttpBinding } from "./BindingHttp.ts";
import { GetTagSyncTask } from "./GetTagSyncTask.ts";

export const GetTagSyncTaskHttp = Layer.effect(
  GetTagSyncTask,
  makeResourceGroupsAccountHttpBinding({
    tag: "AWS.ResourceGroups.GetTagSyncTask",
    operation: resourcegroups.getTagSyncTask,
    actions: ["resource-groups:GetTagSyncTask"],
  }),
);
