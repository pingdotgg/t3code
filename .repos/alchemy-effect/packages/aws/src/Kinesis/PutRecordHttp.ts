import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { PutRecord } from "./PutRecord.ts";

export const PutRecordHttp = Layer.effect(
  PutRecord,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.PutRecord",
    operation: Kinesis.putRecord,
    actions: ["kinesis:PutRecord"],
    key: "StreamName",
  }),
);
