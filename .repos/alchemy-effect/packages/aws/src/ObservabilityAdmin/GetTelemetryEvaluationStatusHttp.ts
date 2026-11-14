import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Layer from "effect/Layer";
import { makeObservabilityAdminHttpBinding } from "./BindingHttp.ts";
import { GetTelemetryEvaluationStatus } from "./GetTelemetryEvaluationStatus.ts";

export const GetTelemetryEvaluationStatusHttp = Layer.effect(
  GetTelemetryEvaluationStatus,
  makeObservabilityAdminHttpBinding({
    capability: "GetTelemetryEvaluationStatus",
    iamActions: ["observabilityadmin:GetTelemetryEvaluationStatus"],
    operation: obs.getTelemetryEvaluationStatus,
  }),
);
