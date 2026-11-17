import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineFarmHttpBinding } from "./BindingHttp.ts";
import { StartSessionsStatisticsAggregation } from "./StartSessionsStatisticsAggregation.ts";

export const StartSessionsStatisticsAggregationHttp = Layer.effect(
  StartSessionsStatisticsAggregation,
  makeDeadlineFarmHttpBinding({
    tag: "AWS.Deadline.StartSessionsStatisticsAggregation",
    operation: deadline.startSessionsStatisticsAggregation,
    actions: ["deadline:StartSessionsStatisticsAggregation"],
  }),
);
