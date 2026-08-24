import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { GetTemplate } from "./GetTemplate.ts";

export const GetTemplateHttp = Layer.effect(
  GetTemplate,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.GetTemplate",
    operation: cloudformation.getTemplate,
    actions: ["cloudformation:GetTemplate"],
  }),
);
