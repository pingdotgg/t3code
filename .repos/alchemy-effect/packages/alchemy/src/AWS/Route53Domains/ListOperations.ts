import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListOperationsRequest
  extends route53domains.ListOperationsRequest {}

/**
 * Runtime binding for `route53domains:ListOperations` — list the
 * asynchronous Route 53 Domains operations (registrations, renewals,
 * transfers, nameserver updates) performed on domains registered by the
 * current AWS account, optionally filtered by status, type, or submission
 * date.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:ListOperations` on `*`. Calls are pinned to `us-east-1`,
 * the only region that serves the Route 53 Domains API, regardless of where
 * the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.ListOperationsHttp)`.
 *
 * @binding
 * @section Tracking Registration Operations
 * @example List In-Progress Operations
 * ```typescript
 * // init
 * const listOperations = yield* AWS.Route53Domains.ListOperations();
 *
 * // runtime
 * const result = yield* listOperations({
 *   Status: ["IN_PROGRESS"],
 *   MaxItems: 20,
 * });
 * const ids = (result.Operations ?? []).map((op) => op.OperationId);
 * ```
 */
export interface ListOperations extends Binding.Service<
  ListOperations,
  "AWS.Route53Domains.ListOperations",
  () => Effect.Effect<
    (
      request: ListOperationsRequest,
    ) => Effect.Effect<
      route53domains.ListOperationsResponse,
      route53domains.ListOperationsError
    >
  >
> {}
export const ListOperations = Binding.Service<ListOperations>(
  "AWS.Route53Domains.ListOperations",
);
