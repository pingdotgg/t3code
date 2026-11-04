import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Layer from "effect/Layer";
import { makeObservabilityAdminHttpBinding } from "./BindingHttp.ts";
import { ListResourceTelemetry } from "./ListResourceTelemetry.ts";

export const ListResourceTelemetryHttp = Layer.effect(
  ListResourceTelemetry,
  makeObservabilityAdminHttpBinding({
    capability: "ListResourceTelemetry",
    iamActions: ["observabilityadmin:ListResourceTelemetry"],
    operation: obs.listResourceTelemetry,
  }),
);
