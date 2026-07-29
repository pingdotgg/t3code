import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Layer from "effect/Layer";
import { makeResourceGroupsAccountHttpBinding } from "./BindingHttp.ts";
import { SearchResources } from "./SearchResources.ts";

export const SearchResourcesHttp = Layer.effect(
  SearchResources,
  makeResourceGroupsAccountHttpBinding({
    tag: "AWS.ResourceGroups.SearchResources",
    operation: resourcegroups.searchResources,
    // Documented minimum permissions: the search reads through the Resource
    // Groups Tagging API and (for stack queries) CloudFormation.
    actions: [
      "resource-groups:SearchResources",
      "tag:GetResources",
      "cloudformation:DescribeStacks",
      "cloudformation:ListStackResources",
    ],
  }),
);
