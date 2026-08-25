import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { CreateCollection } from "./CreateCollection.ts";

export const CreateCollectionHttp = Layer.effect(
  CreateCollection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.CreateCollection",
    operation: rekognition.createCollection,
    actions: ["rekognition:CreateCollection"],
  }),
);
