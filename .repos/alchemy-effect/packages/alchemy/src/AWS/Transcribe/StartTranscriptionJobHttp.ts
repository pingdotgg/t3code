import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { StartTranscriptionJob } from "./StartTranscriptionJob.ts";

export const StartTranscriptionJobHttp = Layer.effect(
  StartTranscriptionJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.StartTranscriptionJob",
    operation: transcribe.startTranscriptionJob,
    actions: ["transcribe:StartTranscriptionJob"],
  }),
);
