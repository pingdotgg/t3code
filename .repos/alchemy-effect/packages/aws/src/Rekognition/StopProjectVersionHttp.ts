import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StopProjectVersion } from "./StopProjectVersion.ts";

export const StopProjectVersionHttp = Layer.effect(
  StopProjectVersion,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StopProjectVersion",
    operation: rekognition.stopProjectVersion,
    actions: ["rekognition:StopProjectVersion"],
  }),
);
