import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { UpdateMedicalVocabulary } from "./UpdateMedicalVocabulary.ts";

export const UpdateMedicalVocabularyHttp = Layer.effect(
  UpdateMedicalVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.UpdateMedicalVocabulary",
    operation: transcribe.updateMedicalVocabulary,
    actions: ["transcribe:UpdateMedicalVocabulary"],
  }),
);
