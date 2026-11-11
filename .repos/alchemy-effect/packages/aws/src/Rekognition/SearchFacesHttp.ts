import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { SearchFaces } from "./SearchFaces.ts";

export const SearchFacesHttp = Layer.effect(
  SearchFaces,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.SearchFaces",
    operation: rekognition.searchFaces,
    actions: ["rekognition:SearchFaces"],
  }),
);
