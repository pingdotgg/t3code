import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { GetVocabulary } from "./GetVocabulary.ts";

export const GetVocabularyHttp = Layer.effect(
  GetVocabulary,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.GetVocabulary",
    operation: transcribe.getVocabulary,
    actions: ["transcribe:GetVocabulary"],
  }),
);
