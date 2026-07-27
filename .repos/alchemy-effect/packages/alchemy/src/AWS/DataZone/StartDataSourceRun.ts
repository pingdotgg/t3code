import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface StartDataSourceRunRequest extends Omit<
  datazone.StartDataSourceRunInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:StartDataSourceRun`.
 *
 * Triggers an on-demand run of a data source in the bound domain, ingesting new technical assets into the inventory. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.StartDataSourceRunHttp)`.
 * @binding
 * @section Data Source Runs
 * @example Trigger an Ingestion Run
 * ```typescript
 * // init — bind the operation to the domain
 * const startDataSourceRun = yield* AWS.DataZone.StartDataSourceRun(domain);
 *
 * // runtime
 * const run = yield* startDataSourceRun({ dataSourceIdentifier: dataSourceId });
 * ```
 */
export interface StartDataSourceRun extends Binding.Service<
  StartDataSourceRun,
  "AWS.DataZone.StartDataSourceRun",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: StartDataSourceRunRequest,
    ) => Effect.Effect<
      datazone.StartDataSourceRunOutput,
      datazone.StartDataSourceRunError
    >
  >
> {}
export const StartDataSourceRun = Binding.Service<StartDataSourceRun>(
  "AWS.DataZone.StartDataSourceRun",
);
