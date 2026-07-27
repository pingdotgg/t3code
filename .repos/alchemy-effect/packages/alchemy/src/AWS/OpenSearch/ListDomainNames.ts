import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListDomainNames` operation (IAM action
 * `es:ListDomainNames`).
 *
 * Lists the names and engine types of all domains the account owns in the active Region — the entry point for fleet-wide monitoring. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.ListDomainNamesHttp)`.
 * @binding
 * @section Monitoring Domains
 * @example List the Account's Domains
 * ```typescript
 * const listDomainNames = yield* OpenSearch.ListDomainNames();
 *
 * const result = yield* listDomainNames();
 * // result.DomainNames → [{ DomainName, EngineType }, …]
 * ```
 */
export interface ListDomainNames extends Binding.Service<
  ListDomainNames,
  "AWS.OpenSearch.ListDomainNames",
  () => Effect.Effect<
    (
      request?: opensearch.ListDomainNamesRequest,
    ) => Effect.Effect<
      opensearch.ListDomainNamesResponse,
      opensearch.ListDomainNamesError
    >
  >
> {}
export const ListDomainNames = Binding.Service<ListDomainNames>(
  "AWS.OpenSearch.ListDomainNames",
);
