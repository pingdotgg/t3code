import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { SearchUsersByImage } from "./SearchUsersByImage.ts";

export const SearchUsersByImageHttp = Layer.effect(
  SearchUsersByImage,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.SearchUsersByImage",
    operation: rekognition.searchUsersByImage,
    actions: ["rekognition:SearchUsersByImage"],
  }),
);
