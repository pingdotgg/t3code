import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListMedicalTranscriptionJobs } from "./ListMedicalTranscriptionJobs.ts";

export const ListMedicalTranscriptionJobsHttp = Layer.effect(
  ListMedicalTranscriptionJobs,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListMedicalTranscriptionJobs",
    operation: transcribe.listMedicalTranscriptionJobs,
    actions: ["transcribe:ListMedicalTranscriptionJobs"],
  }),
);
