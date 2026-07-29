import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationAccountHttpBinding } from "./BindingHttp.ts";
import { ValidateTemplate } from "./ValidateTemplate.ts";

export const ValidateTemplateHttp = Layer.effect(
  ValidateTemplate,
  makeCloudFormationAccountHttpBinding({
    tag: "AWS.CloudFormation.ValidateTemplate",
    operation: cloudformation.validateTemplate,
    actions: ["cloudformation:ValidateTemplate"],
  }),
);
