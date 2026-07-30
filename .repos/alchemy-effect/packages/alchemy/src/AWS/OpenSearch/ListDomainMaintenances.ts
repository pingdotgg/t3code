import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListDomainMaintenances` operation (IAM action
 * `es:ListDomainMaintenances`).
 *
 * Lists a domain's maintenance actions — status and timestamps of past and in-progress reboots and process restarts. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.ListDomainMaintenancesHttp)`.
 * @binding
 * @section Domain Maintenance
 * @example List a Domain's Maintenance History
 * ```typescript
 * const listDomainMaintenances = yield* OpenSearch.ListDomainMaintenances();
 *
 * const result = yield* listDomainMaintenances({ DomainName: name });
 * // result.DomainMaintenances → maintenance history
 * ```
 */
export interface ListDomainMaintenances extends Binding.Service<
  ListDomainMaintenances,
  "AWS.OpenSearch.ListDomainMaintenances",
  () => Effect.Effect<
    (
      request: opensearch.ListDomainMaintenancesRequest,
    ) => Effect.Effect<
      opensearch.ListDomainMaintenancesResponse,
      opensearch.ListDomainMaintenancesError
    >
  >
> {}
export const ListDomainMaintenances = Binding.Service<ListDomainMaintenances>(
  "AWS.OpenSearch.ListDomainMaintenances",
);
