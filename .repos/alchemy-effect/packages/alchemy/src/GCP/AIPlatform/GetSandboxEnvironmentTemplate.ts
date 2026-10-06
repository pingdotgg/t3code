import type * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ReasoningEnginesSandboxEnvironmentTemplate } from "./ReasoningEnginesSandboxEnvironmentTemplate.ts";

export interface GetSandboxEnvironmentTemplateRequest extends Omit<
  aiplatform.GetReasoningEnginesSandboxEnvironmentTemplatesRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `sandboxEnvironmentTemplates.get`.
 *
 * Bind this operation to a
 * {@link ReasoningEnginesSandboxEnvironmentTemplate} in a Function/Action
 * init phase. Provide {@link GetSandboxEnvironmentTemplateHttp}.
 *
 * ### Observing Templates
 * **Example:** Read the bound template
 * ```typescript
 * const getTemplate = yield* GCP.AIPlatform.GetSandboxEnvironmentTemplate(template);
 * const live = yield* getTemplate();
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GetSandboxEnvironmentTemplate extends Binding.Service<
  GetSandboxEnvironmentTemplate,
  "GCP.AIPlatform.GetSandboxEnvironmentTemplate",
  (
    template: ReasoningEnginesSandboxEnvironmentTemplate,
  ) => Effect.Effect<
    (
      request?: GetSandboxEnvironmentTemplateRequest,
    ) => Effect.Effect<
      aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplate,
      aiplatform.GetReasoningEnginesSandboxEnvironmentTemplatesError,
      RuntimeContext
    >
  >
> {}

export const GetSandboxEnvironmentTemplate =
  Binding.Service<GetSandboxEnvironmentTemplate>(
    "GCP.AIPlatform.GetSandboxEnvironmentTemplate",
  );
