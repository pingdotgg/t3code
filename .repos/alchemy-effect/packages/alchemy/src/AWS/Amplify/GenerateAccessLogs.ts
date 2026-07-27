import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface GenerateAccessLogsRequest extends Omit<
  amplify.GenerateAccessLogsRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:GenerateAccessLogs`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * generates a pre-signed URL to the app's access logs for a time range —
 * e.g. an analytics function ingesting traffic data on a schedule. Provide the
 * implementation with `Effect.provide(AWS.Amplify.GenerateAccessLogsHttp)`.
 * @binding
 * @section Reading Access Logs
 * @example Pull the Last Day of Access Logs
 * ```typescript
 * // init — bind the operation to the app
 * const generateAccessLogs = yield* AWS.Amplify.GenerateAccessLogs(app);
 *
 * // runtime — logUrl is a pre-signed CSV download
 * const { logUrl } = yield* generateAccessLogs({
 *   domainName: "example.com",
 *   startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
 *   endTime: new Date(),
 * });
 * ```
 */
export interface GenerateAccessLogs extends Binding.Service<
  GenerateAccessLogs,
  "AWS.Amplify.GenerateAccessLogs",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: GenerateAccessLogsRequest,
    ) => Effect.Effect<
      amplify.GenerateAccessLogsResult,
      amplify.GenerateAccessLogsError
    >
  >
> {}

export const GenerateAccessLogs = Binding.Service<GenerateAccessLogs>(
  "AWS.Amplify.GenerateAccessLogs",
);
