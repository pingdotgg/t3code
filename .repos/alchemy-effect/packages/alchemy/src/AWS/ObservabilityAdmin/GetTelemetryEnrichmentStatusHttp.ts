import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Layer from "effect/Layer";
import { makeObservabilityAdminHttpBinding } from "./BindingHttp.ts";
import { GetTelemetryEnrichmentStatus } from "./GetTelemetryEnrichmentStatus.ts";

export const GetTelemetryEnrichmentStatusHttp = Layer.effect(
  GetTelemetryEnrichmentStatus,
  makeObservabilityAdminHttpBinding({
    capability: "GetTelemetryEnrichmentStatus",
    iamActions: ["observabilityadmin:GetTelemetryEnrichmentStatus"],
    operation: obs.getTelemetryEnrichmentStatus,
  }),
);
