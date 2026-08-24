import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { ListCollections } from "./ListCollections.ts";

export const ListCollectionsHttp = Layer.effect(
  ListCollections,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.ListCollections",
    operation: rekognition.listCollections,
    actions: ["rekognition:ListCollections"],
  }),
);
