import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteMedicalScribeJob } from "./DeleteMedicalScribeJob.ts";

export const DeleteMedicalScribeJobHttp = Layer.effect(
  DeleteMedicalScribeJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteMedicalScribeJob",
    operation: transcribe.deleteMedicalScribeJob,
    actions: ["transcribe:DeleteMedicalScribeJob"],
  }),
);
