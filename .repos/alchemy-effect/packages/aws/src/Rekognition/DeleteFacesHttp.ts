import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DeleteFaces } from "./DeleteFaces.ts";

export const DeleteFacesHttp = Layer.effect(
  DeleteFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DeleteFaces",
    operation: rekognition.deleteFaces,
    actions: ["rekognition:DeleteFaces"],
  }),
);
