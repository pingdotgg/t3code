import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { ListStreamProcessors } from "./ListStreamProcessors.ts";

export const ListStreamProcessorsHttp = Layer.effect(
  ListStreamProcessors,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.ListStreamProcessors",
    operation: rekognition.listStreamProcessors,
    actions: ["rekognition:ListStreamProcessors"],
  }),
);
