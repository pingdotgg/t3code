import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Runtime binding for `emr-serverless:StartApplication`.
 *
 * Starts the bound {@link Application} — pre-warming its pre-initialized
 * capacity ahead of a burst of job submissions so the first job skips the
 * application cold start. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.StartApplicationHttp)`.
 * @binding
 * @section Application Control
 * @example Warm Up Before A Batch Window
 * ```typescript
 * // init
 * const startApplication = yield* AWS.EMRServerless.StartApplication(app);
 *
 * // runtime
 * yield* startApplication();
 * ```
 */
export interface StartApplication extends Binding.Service<
  StartApplication,
  "AWS.EMRServerless.StartApplication",
  (
    application: Application,
  ) => Effect.Effect<
    () => Effect.Effect<emr.StartApplicationResponse, emr.StartApplicationError>
  >
> {}
export const StartApplication = Binding.Service<StartApplication>(
  "AWS.EMRServerless.StartApplication",
);
