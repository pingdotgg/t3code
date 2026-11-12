import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { GetTrainingPipeline } from "./GetTrainingPipeline.ts";
import type { TrainingPipeline } from "./TrainingPipeline.ts";

/**
 * HTTP implementation of {@link GetTrainingPipeline}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetTrainingPipeline
 */
export const GetTrainingPipelineHttp = Layer.effect(
  GetTrainingPipeline,
  makeNamedHttpBinding<
    TrainingPipeline,
    aiplatform.GetProjectsLocationsTrainingPipelinesRequest,
    aiplatform.GoogleCloudAiplatformV1TrainingPipeline,
    aiplatform.GetProjectsLocationsTrainingPipelinesError
  >({
    tag: "GCP.AIPlatform.GetTrainingPipeline",
    operation: aiplatform.getProjectsLocationsTrainingPipelines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
