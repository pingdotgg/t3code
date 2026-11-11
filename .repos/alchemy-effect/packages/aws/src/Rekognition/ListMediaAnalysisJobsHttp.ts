import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { ListMediaAnalysisJobs } from "./ListMediaAnalysisJobs.ts";

export const ListMediaAnalysisJobsHttp = Layer.effect(
  ListMediaAnalysisJobs,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.ListMediaAnalysisJobs",
    operation: rekognition.listMediaAnalysisJobs,
    actions: ["rekognition:ListMediaAnalysisJobs"],
  }),
);
