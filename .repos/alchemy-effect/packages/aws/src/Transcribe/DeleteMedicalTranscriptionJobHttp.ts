import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteMedicalTranscriptionJob } from "./DeleteMedicalTranscriptionJob.ts";

export const DeleteMedicalTranscriptionJobHttp = Layer.effect(
  DeleteMedicalTranscriptionJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteMedicalTranscriptionJob",
    operation: transcribe.deleteMedicalTranscriptionJob,
    actions: ["transcribe:DeleteMedicalTranscriptionJob"],
  }),
);
