import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:BatchGetMembershipDatasources`.
 *
 * Reads this account's data source ingest history across the behavior
 * graphs it is a member of — the member-side view of what each admin's
 * graph is ingesting from this account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.BatchGetMembershipDatasourcesHttp)`.
 * @binding
 * @section Responding to Invitations
 * @example Inspect Membership Data Sources
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchGetMembershipDatasources =
 *   yield* AWS.Detective.BatchGetMembershipDatasources();
 *
 * // runtime
 * const { MembershipDatasources } = yield* batchGetMembershipDatasources({
 *   GraphArns: [adminGraphArn],
 * });
 * ```
 */
export interface BatchGetMembershipDatasources extends Binding.Service<
  BatchGetMembershipDatasources,
  "AWS.Detective.BatchGetMembershipDatasources",
  () => Effect.Effect<
    (
      request: detective.BatchGetMembershipDatasourcesRequest,
    ) => Effect.Effect<
      detective.BatchGetMembershipDatasourcesResponse,
      detective.BatchGetMembershipDatasourcesError
    >
  >
> {}
export const BatchGetMembershipDatasources =
  Binding.Service<BatchGetMembershipDatasources>(
    "AWS.Detective.BatchGetMembershipDatasources",
  );
