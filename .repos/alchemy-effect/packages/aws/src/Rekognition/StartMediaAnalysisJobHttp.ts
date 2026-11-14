import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Layer from "effect/Layer";
import { makeRekognitionHttpBinding } from "./BindingHttp.ts";
import { StartMediaAnalysisJob } from "./StartMediaAnalysisJob.ts";

export const StartMediaAnalysisJobHttp = Layer.effect(
  StartMediaAnalysisJob,
  makeRekognitionHttpBinding({
    tag: "AWS.Rekognition.StartMediaAnalysisJob",
    operation: rekognition.startMediaAnalysisJob,
    actions: ["rekognition:StartMediaAnalysisJob"],
  }),
);
