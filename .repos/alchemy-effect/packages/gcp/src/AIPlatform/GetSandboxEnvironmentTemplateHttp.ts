import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { GetSandboxEnvironmentTemplate } from "./GetSandboxEnvironmentTemplate.ts";
import type { ReasoningEnginesSandboxEnvironmentTemplate } from "./ReasoningEnginesSandboxEnvironmentTemplate.ts";

/**
 * HTTP implementation of {@link GetSandboxEnvironmentTemplate}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetSandboxEnvironmentTemplate
 */
export const GetSandboxEnvironmentTemplateHttp = Layer.effect(
  GetSandboxEnvironmentTemplate,
  makeNamedHttpBinding<
    ReasoningEnginesSandboxEnvironmentTemplate,
    aiplatform.GetReasoningEnginesSandboxEnvironmentTemplatesRequest,
    aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplate,
    aiplatform.GetReasoningEnginesSandboxEnvironmentTemplatesError
  >({
    tag: "GCP.AIPlatform.GetSandboxEnvironmentTemplate",
    operation: aiplatform.getReasoningEnginesSandboxEnvironmentTemplates,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
