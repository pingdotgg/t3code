import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { CreateUser } from "./CreateUser.ts";

export const CreateUserHttp = Layer.effect(
  CreateUser,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.CreateUser",
    operation: rekognition.createUser,
    actions: ["rekognition:CreateUser"],
  }),
);
