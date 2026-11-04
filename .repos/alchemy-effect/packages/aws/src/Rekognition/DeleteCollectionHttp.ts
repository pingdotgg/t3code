import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DeleteCollection } from "./DeleteCollection.ts";

export const DeleteCollectionHttp = Layer.effect(
  DeleteCollection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DeleteCollection",
    operation: rekognition.deleteCollection,
    actions: ["rekognition:DeleteCollection"],
  }),
);
