import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DetectFaces } from "./DetectFaces.ts";

export const DetectFacesHttp = Layer.effect(
  DetectFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DetectFaces",
    operation: rekognition.detectFaces,
    actions: ["rekognition:DetectFaces"],
  }),
);
