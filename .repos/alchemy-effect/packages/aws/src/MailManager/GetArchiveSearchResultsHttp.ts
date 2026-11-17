import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { GetArchiveSearchResults } from "./GetArchiveSearchResults.ts";

export const GetArchiveSearchResultsHttp = Layer.effect(
  GetArchiveSearchResults,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.GetArchiveSearchResults",
    operation: mm.getArchiveSearchResults,
    actions: ["ses:GetArchiveSearchResults"],
  }),
);
