import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { StopArchiveExport } from "./StopArchiveExport.ts";

export const StopArchiveExportHttp = Layer.effect(
  StopArchiveExport,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.StopArchiveExport",
    operation: mm.stopArchiveExport,
    actions: ["ses:StopArchiveExport"],
  }),
);
