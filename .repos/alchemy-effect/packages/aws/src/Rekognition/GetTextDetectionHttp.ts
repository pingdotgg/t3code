import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetTextDetection } from "./GetTextDetection.ts";

export const GetTextDetectionHttp = Layer.effect(
  GetTextDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetTextDetection",
    operation: rekognition.getTextDetection,
    actions: ["rekognition:GetTextDetection"],
  }),
);
