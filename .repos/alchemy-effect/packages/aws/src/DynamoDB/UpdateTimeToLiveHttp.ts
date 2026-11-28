import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { UpdateTimeToLive } from "./UpdateTimeToLive.ts";

export const UpdateTimeToLiveHttp = Layer.effect(
  UpdateTimeToLive,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.UpdateTimeToLive",
    operation: DynamoDB.updateTimeToLive,
    actions: ["dynamodb:UpdateTimeToLive"],
  }),
);
