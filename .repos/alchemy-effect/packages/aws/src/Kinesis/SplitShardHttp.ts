import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { SplitShard } from "./SplitShard.ts";

export const SplitShardHttp = Layer.effect(
  SplitShard,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.SplitShard",
    operation: Kinesis.splitShard,
    actions: ["kinesis:SplitShard"],
    key: "StreamARN",
  }),
);
