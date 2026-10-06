import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { CancelTrainingPipeline } from "./CancelTrainingPipeline.ts";
import type { TrainingPipeline } from "./TrainingPipeline.ts";

/**
 * HTTP implementation of {@link CancelTrainingPipeline}.
 *
 * @layer
 * @provides GCP.AIPlatform.CancelTrainingPipeline
 */
export const CancelTrainingPipelineHttp = Layer.effect(
  CancelTrainingPipeline,
  makeNamedHttpBinding<
    TrainingPipeline,
    aiplatform.CancelProjectsLocationsTrainingPipelinesRequest,
    aiplatform.GoogleProtobufEmpty,
    aiplatform.CancelProjectsLocationsTrainingPipelinesError
  >({
    tag: "GCP.AIPlatform.CancelTrainingPipeline",
    operation: aiplatform.cancelProjectsLocationsTrainingPipelines,
    iam: { role: "roles/aiplatform.user" },
  }),
);
