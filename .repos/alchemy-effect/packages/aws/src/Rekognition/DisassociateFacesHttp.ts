import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DisassociateFaces } from "./DisassociateFaces.ts";

export const DisassociateFacesHttp = Layer.effect(
  DisassociateFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DisassociateFaces",
    operation: rekognition.disassociateFaces,
    actions: ["rekognition:DisassociateFaces"],
  }),
);
