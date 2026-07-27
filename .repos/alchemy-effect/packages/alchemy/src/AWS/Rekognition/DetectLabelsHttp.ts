import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DetectLabels } from "./DetectLabels.ts";

export const DetectLabelsHttp = Layer.effect(
  DetectLabels,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DetectLabels",
    operation: rekognition.detectLabels,
    actions: ["rekognition:DetectLabels"],
  }),
);
