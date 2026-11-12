import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartLabelDetection } from "./StartLabelDetection.ts";

export const StartLabelDetectionHttp = Layer.effect(
  StartLabelDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartLabelDetection",
    operation: rekognition.startLabelDetection,
    actions: ["rekognition:StartLabelDetection"],
  }),
);
