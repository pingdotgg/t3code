import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { ListFaces } from "./ListFaces.ts";

export const ListFacesHttp = Layer.effect(
  ListFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.ListFaces",
    operation: rekognition.listFaces,
    actions: ["rekognition:ListFaces"],
  }),
);
