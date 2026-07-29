import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { SearchFacesByImage } from "./SearchFacesByImage.ts";

export const SearchFacesByImageHttp = Layer.effect(
  SearchFacesByImage,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.SearchFacesByImage",
    operation: rekognition.searchFacesByImage,
    actions: ["rekognition:SearchFacesByImage"],
  }),
);
