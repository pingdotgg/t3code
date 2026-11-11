import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";
import { ResumeSandboxEnvironment } from "./ResumeSandboxEnvironment.ts";

/**
 * HTTP implementation of {@link ResumeSandboxEnvironment}.
 *
 * @layer
 * @provides GCP.AIPlatform.ResumeSandboxEnvironment
 */
export const ResumeSandboxEnvironmentHttp = Layer.effect(
  ResumeSandboxEnvironment,
  makeNamedHttpBinding<
    ReasoningEnginesSandboxEnvironment,
    aiplatform.ResumeReasoningEnginesSandboxEnvironmentsRequest,
    aiplatform.GoogleLongrunningOperation,
    aiplatform.ResumeReasoningEnginesSandboxEnvironmentsError
  >({
    tag: "GCP.AIPlatform.ResumeSandboxEnvironment",
    operation: aiplatform.resumeReasoningEnginesSandboxEnvironments,
    iam: { role: "roles/aiplatform.user" },
  }),
);
