import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListRunsRequest extends omics.ListRunsRequest {}

/**
 * Runtime binding for `omics:ListRuns`.
 *
 * An account-level run-control operation (no resource argument) that lists the workflow runs in the account.
 * Provide the implementation with `Effect.provide(AWS.Omics.ListRunsHttp)`.
 * @binding
 * @section Runs
 * @example Call ListRuns
 * ```typescript
 * // init — account-level binding takes no resource
 * const listRuns = yield* AWS.Omics.ListRuns();
 * // runtime
 * const result = yield* listRuns({ id: runId });
 * ```
 */
export interface ListRuns extends Binding.Service<
  ListRuns,
  "AWS.Omics.ListRuns",
  () => Effect.Effect<
    (
      request?: ListRunsRequest,
    ) => Effect.Effect<omics.ListRunsResponse, omics.ListRunsError>
  >
> {}

export const ListRuns = Binding.Service<ListRuns>("AWS.Omics.ListRuns");
