import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { CreateFaceLivenessSession } from "./CreateFaceLivenessSession.ts";

export const CreateFaceLivenessSessionHttp = Layer.effect(
  CreateFaceLivenessSession,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.CreateFaceLivenessSession",
    operation: rekognition.createFaceLivenessSession,
    actions: ["rekognition:CreateFaceLivenessSession"],
  }),
);
