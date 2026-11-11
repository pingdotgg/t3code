import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeKinesisAccountHttpBinding } from "./BindingHttp.ts";
import { ListStreams } from "./ListStreams.ts";

export const ListStreamsHttp = Layer.effect(
  ListStreams,
  makeKinesisAccountHttpBinding({
    tag: "AWS.Kinesis.ListStreams",
    operation: Kinesis.listStreams,
    actions: ["kinesis:ListStreams"],
  }),
);
