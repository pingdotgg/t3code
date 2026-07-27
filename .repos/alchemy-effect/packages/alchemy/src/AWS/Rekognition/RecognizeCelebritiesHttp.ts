import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { RecognizeCelebrities } from "./RecognizeCelebrities.ts";

export const RecognizeCelebritiesHttp = Layer.effect(
  RecognizeCelebrities,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.RecognizeCelebrities",
    operation: rekognition.recognizeCelebrities,
    actions: ["rekognition:RecognizeCelebrities"],
  }),
);
