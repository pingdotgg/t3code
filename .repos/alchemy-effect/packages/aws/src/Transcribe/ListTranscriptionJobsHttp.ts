import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListTranscriptionJobs } from "./ListTranscriptionJobs.ts";

export const ListTranscriptionJobsHttp = Layer.effect(
  ListTranscriptionJobs,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListTranscriptionJobs",
    operation: transcribe.listTranscriptionJobs,
    actions: ["transcribe:ListTranscriptionJobs"],
  }),
);
