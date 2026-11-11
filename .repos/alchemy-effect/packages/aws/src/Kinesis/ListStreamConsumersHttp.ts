import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { ListStreamConsumers } from "./ListStreamConsumers.ts";

export const ListStreamConsumersHttp = Layer.effect(
  ListStreamConsumers,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.ListStreamConsumers",
    operation: Kinesis.listStreamConsumers,
    actions: ["kinesis:ListStreamConsumers"],
    key: "StreamARN",
  }),
);
