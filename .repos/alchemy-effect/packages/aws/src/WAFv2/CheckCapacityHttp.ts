import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2AccountHttpBinding } from "./BindingHttp.ts";
import { CheckCapacity } from "./CheckCapacity.ts";

export const CheckCapacityHttp = Layer.effect(
  CheckCapacity,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.CheckCapacity",
    operation: wafv2.checkCapacity,
    actions: ["wafv2:CheckCapacity"],
  }),
);
