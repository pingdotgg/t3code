import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StopStreamProcessor } from "./StopStreamProcessor.ts";

export const StopStreamProcessorHttp = Layer.effect(
  StopStreamProcessor,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StopStreamProcessor",
    operation: rekognition.stopStreamProcessor,
    actions: ["rekognition:StopStreamProcessor"],
  }),
);
