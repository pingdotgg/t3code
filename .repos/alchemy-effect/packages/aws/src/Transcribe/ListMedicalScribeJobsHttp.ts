import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListMedicalScribeJobs } from "./ListMedicalScribeJobs.ts";

export const ListMedicalScribeJobsHttp = Layer.effect(
  ListMedicalScribeJobs,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListMedicalScribeJobs",
    operation: transcribe.listMedicalScribeJobs,
    actions: ["transcribe:ListMedicalScribeJobs"],
  }),
);
