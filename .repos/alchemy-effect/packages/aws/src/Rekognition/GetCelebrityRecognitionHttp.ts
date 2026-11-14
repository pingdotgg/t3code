import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetCelebrityRecognition } from "./GetCelebrityRecognition.ts";

export const GetCelebrityRecognitionHttp = Layer.effect(
  GetCelebrityRecognition,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetCelebrityRecognition",
    operation: rekognition.getCelebrityRecognition,
    actions: ["rekognition:GetCelebrityRecognition"],
  }),
);
