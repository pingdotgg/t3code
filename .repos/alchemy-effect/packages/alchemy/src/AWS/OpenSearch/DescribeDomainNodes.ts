import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDomainNodes` operation (IAM action
 * `es:DescribeDomainNodes`).
 *
 * Lists a domain's individual nodes — type (data/master/UltraWarm), Availability Zone, instance type, and storage — for node-level diagnostics. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainNodesHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example List a Domain's Nodes
 * ```typescript
 * const describeDomainNodes = yield* OpenSearch.DescribeDomainNodes();
 *
 * const result = yield* describeDomainNodes({ DomainName: name });
 * // result.DomainNodesStatusList → one entry per node
 * ```
 */
export interface DescribeDomainNodes extends Binding.Service<
  DescribeDomainNodes,
  "AWS.OpenSearch.DescribeDomainNodes",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainNodesRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainNodesResponse,
      opensearch.DescribeDomainNodesError
    >
  >
> {}
export const DescribeDomainNodes = Binding.Service<DescribeDomainNodes>(
  "AWS.OpenSearch.DescribeDomainNodes",
);
