import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { GetMedicalVocabulary } from "./GetMedicalVocabulary.ts";

export const GetMedicalVocabularyHttp = Layer.effect(
  GetMedicalVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.GetMedicalVocabulary",
    operation: transcribe.getMedicalVocabulary,
    actions: ["transcribe:GetMedicalVocabulary"],
  }),
);
