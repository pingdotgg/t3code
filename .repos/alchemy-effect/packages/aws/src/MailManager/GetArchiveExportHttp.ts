import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { GetArchiveExport } from "./GetArchiveExport.ts";

export const GetArchiveExportHttp = Layer.effect(
  GetArchiveExport,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.GetArchiveExport",
    operation: mm.getArchiveExport,
    actions: ["ses:GetArchiveExport"],
  }),
);
