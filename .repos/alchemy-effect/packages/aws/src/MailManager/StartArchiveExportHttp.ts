import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveHttpBinding } from "./BindingHttp.ts";
import { StartArchiveExport } from "./StartArchiveExport.ts";

export const StartArchiveExportHttp = Layer.effect(
  StartArchiveExport,
  makeArchiveHttpBinding({
    tag: "AWS.MailManager.StartArchiveExport",
    operation: mm.startArchiveExport,
    actions: ["ses:StartArchiveExport"],
  }),
);
