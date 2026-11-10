import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListCallAnalyticsCategories } from "./ListCallAnalyticsCategories.ts";

export const ListCallAnalyticsCategoriesHttp = Layer.effect(
  ListCallAnalyticsCategories,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListCallAnalyticsCategories",
    operation: transcribe.listCallAnalyticsCategories,
    actions: ["transcribe:ListCallAnalyticsCategories"],
  }),
);
