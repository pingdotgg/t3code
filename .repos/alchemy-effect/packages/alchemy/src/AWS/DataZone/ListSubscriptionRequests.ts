import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface ListSubscriptionRequestsRequest extends Omit<
  datazone.ListSubscriptionRequestsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:ListSubscriptionRequests`.
 *
 * Lists subscription requests in the bound domain, optionally by status — e.g. the PENDING queue an approval bot works through. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.ListSubscriptionRequestsHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example List Pending Requests
 * ```typescript
 * // init — bind the operation to the domain
 * const listSubscriptionRequests = yield* AWS.DataZone.ListSubscriptionRequests(domain);
 *
 * // runtime
 * const pending = yield* listSubscriptionRequests({ status: "PENDING" });
 * ```
 */
export interface ListSubscriptionRequests extends Binding.Service<
  ListSubscriptionRequests,
  "AWS.DataZone.ListSubscriptionRequests",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionRequestsRequest,
    ) => Effect.Effect<
      datazone.ListSubscriptionRequestsOutput,
      datazone.ListSubscriptionRequestsError
    >
  >
> {}
export const ListSubscriptionRequests =
  Binding.Service<ListSubscriptionRequests>(
    "AWS.DataZone.ListSubscriptionRequests",
  );
