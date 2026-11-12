import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { DescribeQuerySuggestionsConfig } from "./DescribeQuerySuggestionsConfig.ts";

export const DescribeQuerySuggestionsConfigHttp = Layer.effect(
  DescribeQuerySuggestionsConfig,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.DescribeQuerySuggestionsConfig",
    operation: kendra.describeQuerySuggestionsConfig,
    actions: ["kendra:DescribeQuerySuggestionsConfig"],
  }),
);
