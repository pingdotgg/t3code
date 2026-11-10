import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteTranscriptionJob } from "./DeleteTranscriptionJob.ts";

export const DeleteTranscriptionJobHttp = Layer.effect(
  DeleteTranscriptionJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteTranscriptionJob",
    operation: transcribe.deleteTranscriptionJob,
    actions: ["transcribe:DeleteTranscriptionJob"],
  }),
);
