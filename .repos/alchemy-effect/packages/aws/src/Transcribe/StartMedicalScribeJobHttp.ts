import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeRoleHttpBinding } from "./BindingHttp.ts";
import { StartMedicalScribeJob } from "./StartMedicalScribeJob.ts";

export const StartMedicalScribeJobHttp = Layer.effect(
  StartMedicalScribeJob,
  makeTranscribeRoleHttpBinding({
    tag: "AWS.Transcribe.StartMedicalScribeJob",
    operation: transcribe.startMedicalScribeJob,
    actions: ["transcribe:StartMedicalScribeJob"],
  }),
);
