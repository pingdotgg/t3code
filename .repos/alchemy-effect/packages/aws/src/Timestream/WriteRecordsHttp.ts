import * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Layer from "effect/Layer";
import { makeWriteTableHttpBinding } from "./BindingHttp.ts";
import { WriteRecords, type WriteRecordsRequest } from "./WriteRecords.ts";

export const WriteRecordsHttp = Layer.effect(
  WriteRecords,
  makeWriteTableHttpBinding({
    tag: "AWS.Timestream.WriteRecords",
    operation: TSW.writeRecords,
    actions: ["timestream:WriteRecords"],
    toRequest: (request: WriteRecordsRequest, names) => ({
      ...request,
      ...names,
    }),
  }),
);
