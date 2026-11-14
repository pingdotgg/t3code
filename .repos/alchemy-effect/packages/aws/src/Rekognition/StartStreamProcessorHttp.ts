import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartStreamProcessor } from "./StartStreamProcessor.ts";

export const StartStreamProcessorHttp = Layer.effect(
  StartStreamProcessor,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartStreamProcessor",
    operation: rekognition.startStreamProcessor,
    actions: ["rekognition:StartStreamProcessor"],
  }),
);
