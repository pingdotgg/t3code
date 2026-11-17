import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { GenerateAccessLogs } from "./GenerateAccessLogs.ts";

export const GenerateAccessLogsHttp = Layer.effect(
  GenerateAccessLogs,
  makeAmplifyHttpBinding({
    name: "GenerateAccessLogs",
    operation: amplify.generateAccessLogs,
    actions: ["amplify:GenerateAccessLogs"],
    resources: (app) => [app.appArn],
  }),
);
