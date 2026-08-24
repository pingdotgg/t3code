import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeAppRegistryAccountHttpBinding } from "./BindingHttp.ts";
import { SyncResource } from "./SyncResource.ts";

export const SyncResourceHttp = Layer.effect(
  SyncResource,
  makeAppRegistryAccountHttpBinding({
    tag: "AWS.AppRegistry.SyncResource",
    operation: appregistry.syncResource,
    // The target is an arbitrary external resource, so nothing here supports
    // resource-level scoping. SyncResource verifies the CALLER can read and
    // update the target resource, so the documented companion permissions
    // (CloudFormation + resource-tagging) are granted alongside.
    actions: [
      "servicecatalog:SyncResource",
      "cloudformation:DescribeStacks",
      "cloudformation:UpdateStack",
      "tag:GetResources",
      "tag:TagResources",
      "tag:UntagResources",
    ],
  }),
);
