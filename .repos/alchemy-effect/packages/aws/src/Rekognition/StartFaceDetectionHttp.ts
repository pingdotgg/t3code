import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartFaceDetection } from "./StartFaceDetection.ts";

export const StartFaceDetectionHttp = Layer.effect(
  StartFaceDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartFaceDetection",
    operation: rekognition.startFaceDetection,
    actions: ["rekognition:StartFaceDetection"],
  }),
);
