import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListSensitivityInspectionTemplates } from "./ListSensitivityInspectionTemplates.ts";

export const ListSensitivityInspectionTemplatesHttp = Layer.effect(
  ListSensitivityInspectionTemplates,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListSensitivityInspectionTemplates",
    operation: macie2.listSensitivityInspectionTemplates,
    actions: ["macie2:ListSensitivityInspectionTemplates"],
  }),
);
