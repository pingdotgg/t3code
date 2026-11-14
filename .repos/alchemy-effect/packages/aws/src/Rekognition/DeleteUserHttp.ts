import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DeleteUser } from "./DeleteUser.ts";

export const DeleteUserHttp = Layer.effect(
  DeleteUser,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DeleteUser",
    operation: rekognition.deleteUser,
    actions: ["rekognition:DeleteUser"],
  }),
);
