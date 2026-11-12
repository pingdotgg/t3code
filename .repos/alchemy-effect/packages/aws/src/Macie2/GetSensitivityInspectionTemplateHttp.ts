import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetSensitivityInspectionTemplate } from "./GetSensitivityInspectionTemplate.ts";

export const GetSensitivityInspectionTemplateHttp = Layer.effect(
  GetSensitivityInspectionTemplate,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetSensitivityInspectionTemplate",
    operation: macie2.getSensitivityInspectionTemplate,
    actions: ["macie2:GetSensitivityInspectionTemplate"],
  }),
);
