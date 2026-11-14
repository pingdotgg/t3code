import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteMedicalVocabulary } from "./DeleteMedicalVocabulary.ts";

export const DeleteMedicalVocabularyHttp = Layer.effect(
  DeleteMedicalVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteMedicalVocabulary",
    operation: transcribe.deleteMedicalVocabulary,
    actions: ["transcribe:DeleteMedicalVocabulary"],
  }),
);
