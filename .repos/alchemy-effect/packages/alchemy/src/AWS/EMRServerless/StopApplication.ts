import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Runtime binding for `emr-serverless:StopApplication`.
 *
 * Stops the bound {@link Application}, releasing its pre-initialized
 * capacity so it stops billing — e.g. a scheduled cost-control function that
 * shuts the application down outside business hours. Provide the
 * implementation with `Effect.provide(AWS.EMRServerless.StopApplicationHttp)`.
 * @binding
 * @section Application Control
 * @example Stop Outside Business Hours
 * ```typescript
 * // init
 * const stopApplication = yield* AWS.EMRServerless.StopApplication(app);
 *
 * // runtime
 * yield* stopApplication();
 * ```
 */
export interface StopApplication extends Binding.Service<
  StopApplication,
  "AWS.EMRServerless.StopApplication",
  (
    application: Application,
  ) => Effect.Effect<
    () => Effect.Effect<emr.StopApplicationResponse, emr.StopApplicationError>
  >
> {}
export const StopApplication = Binding.Service<StopApplication>(
  "AWS.EMRServerless.StopApplication",
);
