import type * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

export interface PauseSandboxEnvironmentRequest extends Omit<
  aiplatform.PauseReasoningEnginesSandboxEnvironmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `sandboxEnvironments.pause`.
 *
 * Bind this operation to a {@link ReasoningEnginesSandboxEnvironment} in
 * a Function/Action init phase. Provide {@link PauseSandboxEnvironmentHttp}.
 *
 * ### Pausing
 * **Example:** Pause the bound sandbox
 * ```typescript
 * const pause = yield* GCP.AIPlatform.PauseSandboxEnvironment(sandbox);
 * yield* pause({ body: {} });
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface PauseSandboxEnvironment extends Binding.Service<
  PauseSandboxEnvironment,
  "GCP.AIPlatform.PauseSandboxEnvironment",
  (
    sandbox: ReasoningEnginesSandboxEnvironment,
  ) => Effect.Effect<
    (
      request?: PauseSandboxEnvironmentRequest,
    ) => Effect.Effect<
      aiplatform.GoogleLongrunningOperation,
      aiplatform.PauseReasoningEnginesSandboxEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const PauseSandboxEnvironment = Binding.Service<PauseSandboxEnvironment>(
  "GCP.AIPlatform.PauseSandboxEnvironment",
);
