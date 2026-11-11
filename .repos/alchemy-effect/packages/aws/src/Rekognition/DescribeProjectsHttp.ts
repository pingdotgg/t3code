import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { DescribeProjects } from "./DescribeProjects.ts";

export const DescribeProjectsHttp = Layer.effect(
  DescribeProjects,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.DescribeProjects",
    operation: rekognition.describeProjects,
    actions: ["rekognition:DescribeProjects"],
  }),
);
