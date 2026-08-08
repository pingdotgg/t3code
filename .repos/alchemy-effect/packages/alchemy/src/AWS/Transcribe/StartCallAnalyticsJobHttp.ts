import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeRoleHttpBinding } from "./BindingHttp.ts";
import { StartCallAnalyticsJob } from "./StartCallAnalyticsJob.ts";

export const StartCallAnalyticsJobHttp = Layer.effect(
  StartCallAnalyticsJob,
  makeTranscribeRoleHttpBinding({
    tag: "AWS.Transcribe.StartCallAnalyticsJob",
    operation: transcribe.startCallAnalyticsJob,
    actions: ["transcribe:StartCallAnalyticsJob"],
  }),
);
