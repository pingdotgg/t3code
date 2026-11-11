import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { QueryReasoningEngine } from "./QueryReasoningEngine.ts";
import type { ReasoningEngine } from "./ReasoningEngine.ts";

/**
 * HTTP implementation of {@link QueryReasoningEngine}.
 *
 * @layer
 * @provides GCP.AIPlatform.QueryReasoningEngine
 */
export const QueryReasoningEngineHttp = Layer.effect(
  QueryReasoningEngine,
  makeNamedHttpBinding<
    ReasoningEngine,
    aiplatform.QueryReasoningEnginesRequest,
    aiplatform.GoogleCloudAiplatformV1QueryReasoningEngineResponse,
    aiplatform.QueryReasoningEnginesError
  >({
    tag: "GCP.AIPlatform.QueryReasoningEngine",
    operation: aiplatform.queryReasoningEngines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
