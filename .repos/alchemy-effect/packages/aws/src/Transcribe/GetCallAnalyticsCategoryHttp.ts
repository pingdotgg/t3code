import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { GetCallAnalyticsCategory } from "./GetCallAnalyticsCategory.ts";

export const GetCallAnalyticsCategoryHttp = Layer.effect(
  GetCallAnalyticsCategory,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.GetCallAnalyticsCategory",
    operation: transcribe.getCallAnalyticsCategory,
    actions: ["transcribe:GetCallAnalyticsCategory"],
  }),
);
