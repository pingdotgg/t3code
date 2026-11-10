import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { GetRecords } from "./GetRecords.ts";

export const GetRecordsHttp = Layer.effect(
  GetRecords,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.GetRecords",
    operation: Kinesis.getRecords,
    actions: ["kinesis:GetRecords"],
    key: "StreamARN",
  }),
);
