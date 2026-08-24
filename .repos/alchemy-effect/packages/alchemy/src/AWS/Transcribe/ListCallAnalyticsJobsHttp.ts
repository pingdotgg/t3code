import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListCallAnalyticsJobs } from "./ListCallAnalyticsJobs.ts";

export const ListCallAnalyticsJobsHttp = Layer.effect(
  ListCallAnalyticsJobs,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListCallAnalyticsJobs",
    operation: transcribe.listCallAnalyticsJobs,
    actions: ["transcribe:ListCallAnalyticsJobs"],
  }),
);
