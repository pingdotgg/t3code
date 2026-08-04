import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { DescribeTimeToLive } from "./DescribeTimeToLive.ts";

export const DescribeTimeToLiveHttp = Layer.effect(
  DescribeTimeToLive,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.DescribeTimeToLive",
    operation: DynamoDB.describeTimeToLive,
    actions: ["dynamodb:DescribeTimeToLive"],
  }),
);
