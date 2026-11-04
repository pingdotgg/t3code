import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { GetComplianceSummaryByResourceType } from "./GetComplianceSummaryByResourceType.ts";

export const GetComplianceSummaryByResourceTypeHttp = Layer.effect(
  GetComplianceSummaryByResourceType,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.GetComplianceSummaryByResourceType",
    operation: config.getComplianceSummaryByResourceType,
    actions: ["config:GetComplianceSummaryByResourceType"],
  }),
);
