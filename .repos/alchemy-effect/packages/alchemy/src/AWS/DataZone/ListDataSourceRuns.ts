import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface ListDataSourceRunsRequest extends Omit<
  datazone.ListDataSourceRunsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:ListDataSourceRuns`.
 *
 * Lists the runs of a data source in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.ListDataSourceRunsHttp)`.
 * @binding
 * @section Data Source Runs
 * @example List Recent Runs
 * ```typescript
 * // init — bind the operation to the domain
 * const listDataSourceRuns = yield* AWS.DataZone.ListDataSourceRuns(domain);
 *
 * // runtime
 * const runs = yield* listDataSourceRuns({ dataSourceIdentifier: dataSourceId });
 * ```
 */
export interface ListDataSourceRuns extends Binding.Service<
  ListDataSourceRuns,
  "AWS.DataZone.ListDataSourceRuns",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: ListDataSourceRunsRequest,
    ) => Effect.Effect<
      datazone.ListDataSourceRunsOutput,
      datazone.ListDataSourceRunsError
    >
  >
> {}
export const ListDataSourceRuns = Binding.Service<ListDataSourceRuns>(
  "AWS.DataZone.ListDataSourceRuns",
);
