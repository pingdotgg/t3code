import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DetectCustomLabels } from "./DetectCustomLabels.ts";

export const DetectCustomLabelsHttp = Layer.effect(
  DetectCustomLabels,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DetectCustomLabels",
    operation: rekognition.detectCustomLabels,
    actions: ["rekognition:DetectCustomLabels"],
  }),
);
