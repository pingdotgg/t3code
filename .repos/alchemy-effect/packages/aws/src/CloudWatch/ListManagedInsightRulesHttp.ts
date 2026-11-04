import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { ListManagedInsightRules } from "./ListManagedInsightRules.ts";

export const ListManagedInsightRulesHttp = Layer.effect(
  ListManagedInsightRules,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.ListManagedInsightRules",
    operation: cloudwatch.listManagedInsightRules,
    actions: ["cloudwatch:ListManagedInsightRules"],
  }),
);
