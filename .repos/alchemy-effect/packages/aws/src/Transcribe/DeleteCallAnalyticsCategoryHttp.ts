import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteCallAnalyticsCategory } from "./DeleteCallAnalyticsCategory.ts";

export const DeleteCallAnalyticsCategoryHttp = Layer.effect(
  DeleteCallAnalyticsCategory,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteCallAnalyticsCategory",
    operation: transcribe.deleteCallAnalyticsCategory,
    actions: ["transcribe:DeleteCallAnalyticsCategory"],
  }),
);
