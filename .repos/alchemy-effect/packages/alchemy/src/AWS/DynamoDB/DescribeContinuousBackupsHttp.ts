import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { DescribeContinuousBackups } from "./DescribeContinuousBackups.ts";

export const DescribeContinuousBackupsHttp = Layer.effect(
  DescribeContinuousBackups,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.DescribeContinuousBackups",
    operation: DynamoDB.describeContinuousBackups,
    actions: ["dynamodb:DescribeContinuousBackups"],
  }),
);
