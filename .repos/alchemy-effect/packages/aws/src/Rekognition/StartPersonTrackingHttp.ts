import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartPersonTracking } from "./StartPersonTracking.ts";

export const StartPersonTrackingHttp = Layer.effect(
  StartPersonTracking,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartPersonTracking",
    operation: rekognition.startPersonTracking,
    actions: ["rekognition:StartPersonTracking"],
  }),
);
