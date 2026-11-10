import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeTemplateScopedHttpBinding } from "./BindingHttp.ts";
import { RenderEmailTemplate } from "./RenderEmailTemplate.ts";

export const RenderEmailTemplateHttp = Layer.effect(
  RenderEmailTemplate,
  makeTemplateScopedHttpBinding({
    tag: "AWS.SES.RenderEmailTemplate",
    operation: sesv2.testRenderEmailTemplate,
    actions: ["ses:TestRenderEmailTemplate"],
  }),
);
