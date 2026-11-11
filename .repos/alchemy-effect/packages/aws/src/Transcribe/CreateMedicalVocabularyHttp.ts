import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { CreateMedicalVocabulary } from "./CreateMedicalVocabulary.ts";

export const CreateMedicalVocabularyHttp = Layer.effect(
  CreateMedicalVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.CreateMedicalVocabulary",
    operation: transcribe.createMedicalVocabulary,
    actions: ["transcribe:CreateMedicalVocabulary"],
  }),
);
