import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { PutClassificationExportConfiguration } from "./PutClassificationExportConfiguration.ts";

export const PutClassificationExportConfigurationHttp = Layer.effect(
  PutClassificationExportConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.PutClassificationExportConfiguration",
    operation: macie2.putClassificationExportConfiguration,
    actions: ["macie2:PutClassificationExportConfiguration"],
  }),
);
