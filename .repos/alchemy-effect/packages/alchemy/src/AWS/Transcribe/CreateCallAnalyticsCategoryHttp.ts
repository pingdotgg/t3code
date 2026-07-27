import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { CreateCallAnalyticsCategory } from "./CreateCallAnalyticsCategory.ts";

export const CreateCallAnalyticsCategoryHttp = Layer.effect(
  CreateCallAnalyticsCategory,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.CreateCallAnalyticsCategory",
    operation: transcribe.createCallAnalyticsCategory,
    actions: ["transcribe:CreateCallAnalyticsCategory"],
  }),
);
