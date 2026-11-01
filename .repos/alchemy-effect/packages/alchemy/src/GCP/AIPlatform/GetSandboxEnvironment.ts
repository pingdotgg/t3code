import type * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

export interface GetSandboxEnvironmentRequest extends Omit<
  aiplatform.GetReasoningEnginesSandboxEnvironmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `sandboxEnvironments.get`.
 *
 * Bind this operation to a {@link ReasoningEnginesSandboxEnvironment} in
 * a Function/Action init phase. Provide {@link GetSandboxEnvironmentHttp}.
 *
 * ### Observing Sandboxes
 * **Example:** Read the bound sandbox
 * ```typescript
 * const getSandbox = yield* GCP.AIPlatform.GetSandboxEnvironment(sandbox);
 * const live = yield* getSandbox();
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GetSandboxEnvironment extends Binding.Service<
  GetSandboxEnvironment,
  "GCP.AIPlatform.GetSandboxEnvironment",
  (
    sandbox: ReasoningEnginesSandboxEnvironment,
  ) => Effect.Effect<
    (
      request?: GetSandboxEnvironmentRequest,
    ) => Effect.Effect<
      aiplatform.GoogleCloudAiplatformV1SandboxEnvironment,
      aiplatform.GetReasoningEnginesSandboxEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const GetSandboxEnvironment = Binding.Service<GetSandboxEnvironment>(
  "GCP.AIPlatform.GetSandboxEnvironment",
);
