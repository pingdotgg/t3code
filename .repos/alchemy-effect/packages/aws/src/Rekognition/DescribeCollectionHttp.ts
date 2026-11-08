import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DescribeCollection } from "./DescribeCollection.ts";

export const DescribeCollectionHttp = Layer.effect(
  DescribeCollection,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DescribeCollection",
    operation: rekognition.describeCollection,
    actions: ["rekognition:DescribeCollection"],
  }),
);
