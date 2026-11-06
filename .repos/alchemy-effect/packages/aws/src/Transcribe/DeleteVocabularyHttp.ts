import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteVocabulary } from "./DeleteVocabulary.ts";

export const DeleteVocabularyHttp = Layer.effect(
  DeleteVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteVocabulary",
    operation: transcribe.deleteVocabulary,
    actions: ["transcribe:DeleteVocabulary"],
  }),
);
