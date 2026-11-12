import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DescribeProjectVersions } from "./DescribeProjectVersions.ts";

export const DescribeProjectVersionsHttp = Layer.effect(
  DescribeProjectVersions,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DescribeProjectVersions",
    operation: rekognition.describeProjectVersions,
    actions: ["rekognition:DescribeProjectVersions"],
  }),
);
