import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { GetQuerySuggestions } from "./GetQuerySuggestions.ts";

export const GetQuerySuggestionsHttp = Layer.effect(
  GetQuerySuggestions,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.GetQuerySuggestions",
    operation: kendra.getQuerySuggestions,
    actions: ["kendra:GetQuerySuggestions"],
  }),
);
