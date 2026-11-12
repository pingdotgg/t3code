import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Layer from "effect/Layer";
import { makeResourceGroupsAccountHttpBinding } from "./BindingHttp.ts";
import { CancelTagSyncTask } from "./CancelTagSyncTask.ts";

export const CancelTagSyncTaskHttp = Layer.effect(
  CancelTagSyncTask,
  makeResourceGroupsAccountHttpBinding({
    tag: "AWS.ResourceGroups.CancelTagSyncTask",
    operation: resourcegroups.cancelTagSyncTask,
    actions: ["resource-groups:CancelTagSyncTask"],
  }),
);
