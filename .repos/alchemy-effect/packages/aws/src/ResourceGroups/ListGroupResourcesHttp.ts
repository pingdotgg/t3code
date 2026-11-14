import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Layer from "effect/Layer";
import { makeResourceGroupsGroupHttpBinding } from "./BindingHttp.ts";
import { ListGroupResources } from "./ListGroupResources.ts";

export const ListGroupResourcesHttp = Layer.effect(
  ListGroupResources,
  makeResourceGroupsGroupHttpBinding({
    tag: "AWS.ResourceGroups.ListGroupResources",
    operation: resourcegroups.listGroupResources,
    actions: ["resource-groups:ListGroupResources"],
    // Documented minimum permissions: member enumeration reads through the
    // Resource Groups Tagging API and (for CLOUDFORMATION_STACK_1_0 groups)
    // the owning stack, on arbitrary member ARNs.
    supportingActions: [
      "tag:GetResources",
      "cloudformation:DescribeStacks",
      "cloudformation:ListStackResources",
    ],
  }),
);
