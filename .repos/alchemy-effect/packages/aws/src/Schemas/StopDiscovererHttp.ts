import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasDiscovererHttpBinding } from "./BindingHttp.ts";
import { StopDiscoverer } from "./StopDiscoverer.ts";

export const StopDiscovererHttp = Layer.effect(
  StopDiscoverer,
  makeSchemasDiscovererHttpBinding({
    tag: "AWS.Schemas.StopDiscoverer",
    operation: schemas.stopDiscoverer,
    actions: ["schemas:StopDiscoverer"],
    // StopDiscoverer disables the discoverer's managed EventBridge rule.
    ruleActions: ["events:DisableRule"],
  }),
);
