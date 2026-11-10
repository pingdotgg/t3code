import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { GetLogGroupFields } from "./GetLogGroupFields.ts";

export const GetLogGroupFieldsHttp = Layer.effect(
  GetLogGroupFields,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.GetLogGroupFields",
    operation: Logs.getLogGroupFields,
    actions: ["logs:GetLogGroupFields"],
  }),
);
