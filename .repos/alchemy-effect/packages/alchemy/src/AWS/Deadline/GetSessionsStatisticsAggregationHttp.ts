import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineFarmHttpBinding } from "./BindingHttp.ts";
import { GetSessionsStatisticsAggregation } from "./GetSessionsStatisticsAggregation.ts";

export const GetSessionsStatisticsAggregationHttp = Layer.effect(
  GetSessionsStatisticsAggregation,
  makeDeadlineFarmHttpBinding({
    tag: "AWS.Deadline.GetSessionsStatisticsAggregation",
    operation: deadline.getSessionsStatisticsAggregation,
    actions: ["deadline:GetSessionsStatisticsAggregation"],
  }),
);
