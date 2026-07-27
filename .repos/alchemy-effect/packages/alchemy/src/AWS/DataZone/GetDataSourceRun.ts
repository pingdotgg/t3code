import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetDataSourceRunRequest extends Omit<
  datazone.GetDataSourceRunInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetDataSourceRun`.
 *
 * Reads the status of a data source run in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetDataSourceRunHttp)`.
 * @binding
 * @section Data Source Runs
 * @example Poll a Run to Completion
 * ```typescript
 * // init — bind the operation to the domain
 * const getDataSourceRun = yield* AWS.DataZone.GetDataSourceRun(domain);
 *
 * // runtime
 * const run = yield* getDataSourceRun({ identifier: runId });
 * if (run.status === "FAILED") { yield* Effect.logError(run.errorMessage); }
 * ```
 */
export interface GetDataSourceRun extends Binding.Service<
  GetDataSourceRun,
  "AWS.DataZone.GetDataSourceRun",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetDataSourceRunRequest,
    ) => Effect.Effect<
      datazone.GetDataSourceRunOutput,
      datazone.GetDataSourceRunError
    >
  >
> {}
export const GetDataSourceRun = Binding.Service<GetDataSourceRun>(
  "AWS.DataZone.GetDataSourceRun",
);
