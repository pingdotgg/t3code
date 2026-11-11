import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetLabelDetection } from "./GetLabelDetection.ts";

export const GetLabelDetectionHttp = Layer.effect(
  GetLabelDetection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetLabelDetection",
    operation: rekognition.getLabelDetection,
    actions: ["rekognition:GetLabelDetection"],
  }),
);
