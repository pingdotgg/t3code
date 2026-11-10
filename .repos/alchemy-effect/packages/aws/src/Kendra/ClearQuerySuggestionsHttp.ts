import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { ClearQuerySuggestions } from "./ClearQuerySuggestions.ts";

export const ClearQuerySuggestionsHttp = Layer.effect(
  ClearQuerySuggestions,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.ClearQuerySuggestions",
    operation: kendra.clearQuerySuggestions,
    actions: ["kendra:ClearQuerySuggestions"],
  }),
);
