import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Layer from "effect/Layer";
import { makeResourceGroupsGroupHttpBinding } from "./BindingHttp.ts";
import { ListGroupingStatuses } from "./ListGroupingStatuses.ts";

export const ListGroupingStatusesHttp = Layer.effect(
  ListGroupingStatuses,
  makeResourceGroupsGroupHttpBinding({
    tag: "AWS.ResourceGroups.ListGroupingStatuses",
    operation: resourcegroups.listGroupingStatuses,
    actions: ["resource-groups:ListGroupingStatuses"],
  }),
);
