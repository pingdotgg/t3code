import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { GetSandboxEnvironment } from "./GetSandboxEnvironment.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

/**
 * HTTP implementation of {@link GetSandboxEnvironment}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetSandboxEnvironment
 */
export const GetSandboxEnvironmentHttp = Layer.effect(
  GetSandboxEnvironment,
  makeNamedHttpBinding<
    ReasoningEnginesSandboxEnvironment,
    aiplatform.GetReasoningEnginesSandboxEnvironmentsRequest,
    aiplatform.GoogleCloudAiplatformV1SandboxEnvironment,
    aiplatform.GetReasoningEnginesSandboxEnvironmentsError
  >({
    tag: "GCP.AIPlatform.GetSandboxEnvironment",
    operation: aiplatform.getReasoningEnginesSandboxEnvironments,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
