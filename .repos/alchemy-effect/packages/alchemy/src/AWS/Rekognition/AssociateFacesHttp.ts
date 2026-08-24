import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { AssociateFaces } from "./AssociateFaces.ts";

export const AssociateFacesHttp = Layer.effect(
  AssociateFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.AssociateFaces",
    operation: rekognition.associateFaces,
    actions: ["rekognition:AssociateFaces"],
  }),
);
