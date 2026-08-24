import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { StopArchiveSearch } from "./StopArchiveSearch.ts";

export const StopArchiveSearchHttp = Layer.effect(
  StopArchiveSearch,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.StopArchiveSearch",
    operation: mm.stopArchiveSearch,
    actions: ["ses:StopArchiveSearch"],
  }),
);
