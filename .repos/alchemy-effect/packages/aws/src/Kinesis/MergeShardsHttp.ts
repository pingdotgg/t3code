import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { MergeShards } from "./MergeShards.ts";

export const MergeShardsHttp = Layer.effect(
  MergeShards,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.MergeShards",
    operation: Kinesis.mergeShards,
    actions: ["kinesis:MergeShards"],
    key: "StreamARN",
  }),
);
