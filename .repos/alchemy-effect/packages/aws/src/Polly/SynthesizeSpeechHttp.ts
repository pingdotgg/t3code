import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { SynthesizeSpeech } from "./SynthesizeSpeech.ts";

// polly:SynthesizeSpeech only supports resource-level IAM for lexicons; the
// synthesis call itself is account-wide, so the grant is Resource: ["*"]
// (which also covers any LexiconNames in the request).
export const SynthesizeSpeechHttp = Layer.effect(
  SynthesizeSpeech,
  makePollyHttpBinding({
    capability: "SynthesizeSpeech",
    iamActions: ["polly:SynthesizeSpeech"],
    operation: polly.synthesizeSpeech,
  }),
);
