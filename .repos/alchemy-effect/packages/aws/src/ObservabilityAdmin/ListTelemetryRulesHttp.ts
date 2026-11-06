import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Layer from "effect/Layer";
import { makeObservabilityAdminHttpBinding } from "./BindingHttp.ts";
import { ListTelemetryRules } from "./ListTelemetryRules.ts";

export const ListTelemetryRulesHttp = Layer.effect(
  ListTelemetryRules,
  makeObservabilityAdminHttpBinding({
    capability: "ListTelemetryRules",
    iamActions: ["observabilityadmin:ListTelemetryRules"],
    operation: obs.listTelemetryRules,
  }),
);
