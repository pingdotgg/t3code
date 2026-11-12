import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { CompareFaces } from "./CompareFaces.ts";

export const CompareFacesHttp = Layer.effect(
  CompareFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.CompareFaces",
    operation: rekognition.compareFaces,
    actions: ["rekognition:CompareFaces"],
  }),
);
