import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { StartMedicalTranscriptionJob } from "./StartMedicalTranscriptionJob.ts";

export const StartMedicalTranscriptionJobHttp = Layer.effect(
  StartMedicalTranscriptionJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.StartMedicalTranscriptionJob",
    operation: transcribe.startMedicalTranscriptionJob,
    actions: ["transcribe:StartMedicalTranscriptionJob"],
  }),
);
