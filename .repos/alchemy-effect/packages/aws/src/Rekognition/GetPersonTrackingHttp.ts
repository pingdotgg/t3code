import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetPersonTracking } from "./GetPersonTracking.ts";

export const GetPersonTrackingHttp = Layer.effect(
  GetPersonTracking,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetPersonTracking",
    operation: rekognition.getPersonTracking,
    actions: ["rekognition:GetPersonTracking"],
  }),
);
