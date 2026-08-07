import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ExportQAppSessionData} — `instanceId` is injected from the bound Q App.
 */
export interface ExportQAppSessionDataRequest extends Omit<
  qapps.ExportQAppSessionDataInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:ExportQAppSessionData`.
 *
 * Exports a shared Q App session's collected data as a downloadable CSV file link. Provide the implementation with
 * `Effect.provide(AWS.QApps.ExportQAppSessionDataHttp)`.
 * @binding
 * @section Sessions
 * @example Export Session Data
 * ```typescript
 * // init — bind the operation to the Q App
 * const exportQAppSessionData = yield* AWS.QApps.ExportQAppSessionData(app);
 *
 * // runtime
 * const exported = yield* exportQAppSessionData({ sessionId });
 * console.log(exported.csvFileLink);
 * ```
 */
export interface ExportQAppSessionData extends Binding.Service<
  ExportQAppSessionData,
  "AWS.QApps.ExportQAppSessionData",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: ExportQAppSessionDataRequest,
    ) => Effect.Effect<
      qapps.ExportQAppSessionDataOutput,
      qapps.ExportQAppSessionDataError
    >
  >
> {}

export const ExportQAppSessionData = Binding.Service<ExportQAppSessionData>(
  "AWS.QApps.ExportQAppSessionData",
);
