import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetFaceDetection } from "./GetFaceDetection.ts";

export const GetFaceDetectionHttp = Layer.effect(
  GetFaceDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetFaceDetection",
    operation: rekognition.getFaceDetection,
    actions: ["rekognition:GetFaceDetection"],
  }),
);
