import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Layer from "effect/Layer";
import { makeElastiCacheAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEvents } from "./DescribeEvents.ts";

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeElastiCacheAccountHttpBinding({
    tag: "AWS.ElastiCache.DescribeEvents",
    operation: elasticache.describeEvents,
    actions: ["elasticache:DescribeEvents"],
  }),
);
