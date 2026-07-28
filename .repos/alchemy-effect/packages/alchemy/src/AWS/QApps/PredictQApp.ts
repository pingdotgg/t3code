import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link PredictQApp} — `instanceId` is injected from the bound Q App.
 */
export interface PredictQAppRequest extends Omit<
  qapps.PredictQAppInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:PredictQApp`.
 *
 * Generates a Q App definition from a natural-language problem statement or a Q Business conversation. Provide the implementation with
 * `Effect.provide(AWS.QApps.PredictQAppHttp)`.
 * @binding
 * @section Generation
 * @example Generate an App Definition from a Prompt
 * ```typescript
 * // init — bind the operation to the Q App
 * const predictQApp = yield* AWS.QApps.PredictQApp(app);
 *
 * // runtime
 * const predicted = yield* predictQApp({
 *   options: {
 *     problemStatement: "Summarize meeting notes into action items",
 *   },
 * });
 * console.log(predicted.app.title);
 * ```
 */
export interface PredictQApp extends Binding.Service<
  PredictQApp,
  "AWS.QApps.PredictQApp",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: PredictQAppRequest,
    ) => Effect.Effect<qapps.PredictQAppOutput, qapps.PredictQAppError>
  >
> {}

export const PredictQApp = Binding.Service<PredictQApp>(
  "AWS.QApps.PredictQApp",
);
