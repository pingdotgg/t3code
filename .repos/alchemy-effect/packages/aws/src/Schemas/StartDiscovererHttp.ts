import * as schemas from "@distilled.cloud/aws/schemas";
import * as Layer from "effect/Layer";
import { makeSchemasDiscovererHttpBinding } from "./BindingHttp.ts";
import { StartDiscoverer } from "./StartDiscoverer.ts";

export const StartDiscovererHttp = Layer.effect(
  StartDiscoverer,
  makeSchemasDiscovererHttpBinding({
    tag: "AWS.Schemas.StartDiscoverer",
    operation: schemas.startDiscoverer,
    actions: ["schemas:StartDiscoverer"],
    // StartDiscoverer re-enables the discoverer's managed EventBridge rule.
    ruleActions: ["events:EnableRule"],
  }),
);
