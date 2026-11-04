import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.ListUsers",
    operation: rekognition.listUsers,
    actions: ["rekognition:ListUsers"],
  }),
);
