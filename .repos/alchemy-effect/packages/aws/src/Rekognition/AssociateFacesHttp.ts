import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { AssociateFaces } from "./AssociateFaces.ts";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";

export const AssociateFacesHttp = Layer.effect(
  AssociateFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.AssociateFaces",
    operation: rekognition.associateFaces,
    actions: ["rekognition:AssociateFaces"],
  }),
);
