import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationAccountHttpBinding } from "./BindingHttp.ts";
import { ListExports } from "./ListExports.ts";

export const ListExportsHttp = Layer.effect(
  ListExports,
  makeCloudFormationAccountHttpBinding({
    tag: "AWS.CloudFormation.ListExports",
    operation: cloudformation.listExports,
    actions: ["cloudformation:ListExports"],
  }),
);
