import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetCelebrityInfo } from "./GetCelebrityInfo.ts";

export const GetCelebrityInfoHttp = Layer.effect(
  GetCelebrityInfo,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetCelebrityInfo",
    operation: rekognition.getCelebrityInfo,
    actions: ["rekognition:GetCelebrityInfo"],
  }),
);
