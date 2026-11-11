import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { GetShardIterator } from "./GetShardIterator.ts";

export const GetShardIteratorHttp = Layer.effect(
  GetShardIterator,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.GetShardIterator",
    operation: Kinesis.getShardIterator,
    actions: ["kinesis:GetShardIterator"],
    key: "StreamARN",
  }),
);
