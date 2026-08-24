import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartProjectVersion } from "./StartProjectVersion.ts";

export const StartProjectVersionHttp = Layer.effect(
  StartProjectVersion,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartProjectVersion",
    operation: rekognition.startProjectVersion,
    actions: ["rekognition:StartProjectVersion"],
  }),
);
