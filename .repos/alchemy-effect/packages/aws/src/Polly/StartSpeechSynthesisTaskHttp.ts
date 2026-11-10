import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { StartSpeechSynthesisTask } from "./StartSpeechSynthesisTask.ts";

export const StartSpeechSynthesisTaskHttp = Layer.effect(
  StartSpeechSynthesisTask,
  makePollyHttpBinding({
    capability: "StartSpeechSynthesisTask",
    iamActions: ["polly:StartSpeechSynthesisTask"],
    operation: polly.startSpeechSynthesisTask,
  }),
);
