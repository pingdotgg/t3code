import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { GetReasoningEngine } from "./GetReasoningEngine.ts";
import type { ReasoningEngine } from "./ReasoningEngine.ts";

/**
 * HTTP implementation of {@link GetReasoningEngine}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetReasoningEngine
 */
export const GetReasoningEngineHttp = Layer.effect(
  GetReasoningEngine,
  makeNamedHttpBinding<
    ReasoningEngine,
    aiplatform.GetReasoningEnginesRequest,
    aiplatform.GoogleCloudAiplatformV1ReasoningEngine,
    aiplatform.GetReasoningEnginesError
  >({
    tag: "GCP.AIPlatform.GetReasoningEngine",
    operation: aiplatform.getReasoningEngines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
