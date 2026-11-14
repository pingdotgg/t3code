import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetFaceLivenessSessionResults } from "./GetFaceLivenessSessionResults.ts";

export const GetFaceLivenessSessionResultsHttp = Layer.effect(
  GetFaceLivenessSessionResults,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetFaceLivenessSessionResults",
    operation: rekognition.getFaceLivenessSessionResults,
    actions: ["rekognition:GetFaceLivenessSessionResults"],
  }),
);
