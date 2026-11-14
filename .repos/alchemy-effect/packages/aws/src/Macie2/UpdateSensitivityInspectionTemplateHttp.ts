import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateSensitivityInspectionTemplate } from "./UpdateSensitivityInspectionTemplate.ts";

export const UpdateSensitivityInspectionTemplateHttp = Layer.effect(
  UpdateSensitivityInspectionTemplate,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateSensitivityInspectionTemplate",
    operation: macie2.updateSensitivityInspectionTemplate,
    actions: ["macie2:UpdateSensitivityInspectionTemplate"],
  }),
);
