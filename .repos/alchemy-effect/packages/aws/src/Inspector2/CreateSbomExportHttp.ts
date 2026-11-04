import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { CreateSbomExport } from "./CreateSbomExport.ts";

export const CreateSbomExportHttp = Layer.effect(
  CreateSbomExport,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.CreateSbomExport",
    operation: inspector2.createSbomExport,
    actions: ["inspector2:CreateSbomExport"],
  }),
);
