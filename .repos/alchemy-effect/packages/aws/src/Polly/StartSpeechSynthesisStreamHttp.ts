import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { StartSpeechSynthesisStream } from "./StartSpeechSynthesisStream.ts";

export const StartSpeechSynthesisStreamHttp = Layer.effect(
  StartSpeechSynthesisStream,
  makePollyHttpBinding({
    capability: "StartSpeechSynthesisStream",
    iamActions: ["polly:StartSpeechSynthesisStream"],
    operation: polly.startSpeechSynthesisStream,
  }),
);
