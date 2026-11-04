import * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import * as Layer from "effect/Layer";
import { makeExportHttpBinding } from "./BindingHttp.ts";
import { GetExport } from "./GetExport.ts";

export const GetExportHttp = Layer.effect(
  GetExport,
  makeExportHttpBinding({
    capability: "GetExport",
    iamActions: ["bcm-data-exports:GetExport"],
    operation: bcm.getExport,
  }),
);
