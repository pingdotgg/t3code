import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { CreateLogStream } from "./CreateLogStream.ts";

export const CreateLogStreamHttp = Layer.effect(
  CreateLogStream,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.CreateLogStream",
    operation: Logs.createLogStream,
    actions: ["logs:CreateLogStream"],
  }),
);
