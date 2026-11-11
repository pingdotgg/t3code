import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { ListShards } from "./ListShards.ts";

export const ListShardsHttp = Layer.effect(
  ListShards,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.ListShards",
    operation: Kinesis.listShards,
    actions: ["kinesis:ListShards"],
    key: "StreamARN",
  }),
);
