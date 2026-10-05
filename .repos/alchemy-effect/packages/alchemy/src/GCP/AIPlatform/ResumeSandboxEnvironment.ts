import type * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

export interface ResumeSandboxEnvironmentRequest extends Omit<
  aiplatform.ResumeReasoningEnginesSandboxEnvironmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `sandboxEnvironments.resume`.
 *
 * Bind this operation to a {@link ReasoningEnginesSandboxEnvironment} in
 * a Function/Action init phase. Provide {@link ResumeSandboxEnvironmentHttp}.
 *
 * ### Resuming
 * **Example:** Resume the bound sandbox
 * ```typescript
 * const resume = yield* GCP.AIPlatform.ResumeSandboxEnvironment(sandbox);
 * yield* resume({ body: {} });
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface ResumeSandboxEnvironment extends Binding.Service<
  ResumeSandboxEnvironment,
  "GCP.AIPlatform.ResumeSandboxEnvironment",
  (
    sandbox: ReasoningEnginesSandboxEnvironment,
  ) => Effect.Effect<
    (
      request?: ResumeSandboxEnvironmentRequest,
    ) => Effect.Effect<
      aiplatform.GoogleLongrunningOperation,
      aiplatform.ResumeReasoningEnginesSandboxEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const ResumeSandboxEnvironment =
  Binding.Service<ResumeSandboxEnvironment>(
    "GCP.AIPlatform.ResumeSandboxEnvironment",
  );
