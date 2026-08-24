import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DescribeStreamProcessor } from "./DescribeStreamProcessor.ts";

export const DescribeStreamProcessorHttp = Layer.effect(
  DescribeStreamProcessor,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DescribeStreamProcessor",
    operation: rekognition.describeStreamProcessor,
    actions: ["rekognition:DescribeStreamProcessor"],
  }),
);
