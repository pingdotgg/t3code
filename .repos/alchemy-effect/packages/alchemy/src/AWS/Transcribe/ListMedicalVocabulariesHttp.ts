import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListMedicalVocabularies } from "./ListMedicalVocabularies.ts";

export const ListMedicalVocabulariesHttp = Layer.effect(
  ListMedicalVocabularies,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListMedicalVocabularies",
    operation: transcribe.listMedicalVocabularies,
    actions: ["transcribe:ListMedicalVocabularies"],
  }),
);
