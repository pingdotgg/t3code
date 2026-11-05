import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";
import { CreateStarterMappingTemplate } from "./CreateStarterMappingTemplate.ts";

export const CreateStarterMappingTemplateHttp = Layer.effect(
  CreateStarterMappingTemplate,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.CreateStarterMappingTemplate",
    operation: b2bi.createStarterMappingTemplate,
    // `outputSampleLocation` is written through the caller's session
    // (forward-access), so the S3 write grant rides along.
    actions: ["b2bi:CreateStarterMappingTemplate", "s3:PutObject"],
  }),
);
