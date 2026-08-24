import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveHttpBinding } from "./BindingHttp.ts";
import { StartArchiveSearch } from "./StartArchiveSearch.ts";

export const StartArchiveSearchHttp = Layer.effect(
  StartArchiveSearch,
  makeArchiveHttpBinding({
    tag: "AWS.MailManager.StartArchiveSearch",
    operation: mm.startArchiveSearch,
    actions: ["ses:StartArchiveSearch"],
  }),
);
