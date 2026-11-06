import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveHttpBinding } from "./BindingHttp.ts";
import { ListArchiveExports } from "./ListArchiveExports.ts";

export const ListArchiveExportsHttp = Layer.effect(
  ListArchiveExports,
  makeArchiveHttpBinding({
    tag: "AWS.MailManager.ListArchiveExports",
    operation: mm.listArchiveExports,
    actions: ["ses:ListArchiveExports"],
  }),
);
