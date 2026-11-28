import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import { PauseSandboxEnvironment } from "./PauseSandboxEnvironment.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

/**
 * HTTP implementation of {@link PauseSandboxEnvironment}.
 *
 * @layer
 * @provides GCP.AIPlatform.PauseSandboxEnvironment
 */
export const PauseSandboxEnvironmentHttp = Layer.effect(
  PauseSandboxEnvironment,
  makeNamedHttpBinding<
    ReasoningEnginesSandboxEnvironment,
    aiplatform.PauseReasoningEnginesSandboxEnvironmentsRequest,
    aiplatform.GoogleLongrunningOperation,
    aiplatform.PauseReasoningEnginesSandboxEnvironmentsError
  >({
    tag: "GCP.AIPlatform.PauseSandboxEnvironment",
    operation: aiplatform.pauseReasoningEnginesSandboxEnvironments,
    iam: { role: "roles/aiplatform.user" },
  }),
);
