import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { GetContentModeration } from "./GetContentModeration.ts";

export const GetContentModerationHttp = Layer.effect(
  GetContentModeration,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.GetContentModeration",
    operation: rekognition.getContentModeration,
    actions: ["rekognition:GetContentModeration"],
  }),
);
