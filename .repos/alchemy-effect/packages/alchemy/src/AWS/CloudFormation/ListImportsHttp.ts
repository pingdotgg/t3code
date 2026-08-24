import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationAccountHttpBinding } from "./BindingHttp.ts";
import { ListImports } from "./ListImports.ts";

export const ListImportsHttp = Layer.effect(
  ListImports,
  makeCloudFormationAccountHttpBinding({
    tag: "AWS.CloudFormation.ListImports",
    operation: cloudformation.listImports,
    actions: ["cloudformation:ListImports"],
  }),
);
