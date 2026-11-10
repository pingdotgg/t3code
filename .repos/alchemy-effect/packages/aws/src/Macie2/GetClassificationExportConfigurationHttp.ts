import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetClassificationExportConfiguration } from "./GetClassificationExportConfiguration.ts";

export const GetClassificationExportConfigurationHttp = Layer.effect(
  GetClassificationExportConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetClassificationExportConfiguration",
    operation: macie2.getClassificationExportConfiguration,
    actions: ["macie2:GetClassificationExportConfiguration"],
  }),
);
