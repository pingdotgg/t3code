import type * as mwaa from "@distilled.cloud/aws/mwaa";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Environment } from "./Environment.ts";

/**
 * Runtime binding for `airflow:GetEnvironment`.
 *
 * Bind an {@link Environment} inside a function runtime to observe the
 * environment's live status, webserver URL, and last-update details — useful
 * for health checks and for gating REST API calls on `Status === "AVAILABLE"`.
 * Provide the implementation with
 * `Effect.provide(AWS.MWAA.GetEnvironmentHttp)`.
 * @binding
 * @section Describing the Environment
 * @example Check Environment Health
 * ```typescript
 * // init — bind the operation to the environment
 * const getEnvironment = yield* AWS.MWAA.GetEnvironment(environment);
 *
 * // runtime — observe live status
 * const result = yield* getEnvironment();
 * const healthy = result.Environment?.Status === "AVAILABLE";
 * ```
 */
export interface GetEnvironment extends Binding.Service<
  GetEnvironment,
  "AWS.MWAA.GetEnvironment",
  (
    environment: Environment,
  ) => Effect.Effect<
    () => Effect.Effect<mwaa.GetEnvironmentOutput, mwaa.GetEnvironmentError>
  >
> {}

export const GetEnvironment = Binding.Service<GetEnvironment>(
  "AWS.MWAA.GetEnvironment",
);
