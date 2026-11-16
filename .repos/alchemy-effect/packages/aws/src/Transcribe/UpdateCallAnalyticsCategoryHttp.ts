import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { UpdateCallAnalyticsCategory } from "./UpdateCallAnalyticsCategory.ts";

export const UpdateCallAnalyticsCategoryHttp = Layer.effect(
  UpdateCallAnalyticsCategory,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.UpdateCallAnalyticsCategory",
    operation: transcribe.updateCallAnalyticsCategory,
    actions: ["transcribe:UpdateCallAnalyticsCategory"],
  }),
);
