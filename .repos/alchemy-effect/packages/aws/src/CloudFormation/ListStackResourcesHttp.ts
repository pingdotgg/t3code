import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { ListStackResources } from "./ListStackResources.ts";

export const ListStackResourcesHttp = Layer.effect(
  ListStackResources,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.ListStackResources",
    operation: cloudformation.listStackResources,
    actions: ["cloudformation:ListStackResources"],
  }),
);
