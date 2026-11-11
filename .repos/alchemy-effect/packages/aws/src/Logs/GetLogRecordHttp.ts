import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { GetLogRecord } from "./GetLogRecord.ts";

export const GetLogRecordHttp = Layer.effect(
  GetLogRecord,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.GetLogRecord",
    operation: Logs.getLogRecord,
    actions: ["logs:GetLogRecord"],
    // Scoped by the record pointer from a query-result row.
    injectLogGroupName: false,
  }),
);
