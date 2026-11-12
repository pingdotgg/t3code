import * as appsync from "@distilled.cloud/aws/appsync";
import * as Layer from "effect/Layer";
import { makeAppSyncAccountHttpBinding } from "./BindingHttp.ts";
import { EvaluateCode } from "./EvaluateCode.ts";

/**
 * HTTP implementation of the {@link EvaluateCode} binding. Calls
 * `appsync:EvaluateCode` with the host Function's IAM role. The action
 * defines no IAM resource types, so the grant is necessarily
 * `Resource: "*"`.
 */
export const EvaluateCodeHttp = Layer.effect(
  EvaluateCode,
  makeAppSyncAccountHttpBinding({
    tag: "AWS.AppSync.EvaluateCode",
    actions: ["appsync:EvaluateCode"],
    operation: appsync.evaluateCode,
  }),
);
