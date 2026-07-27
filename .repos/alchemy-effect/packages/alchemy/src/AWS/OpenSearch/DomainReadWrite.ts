import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OpenSearchApiError } from "./DataPlaneTypes.ts";
import type { Domain } from "./Domain.ts";
import type { ReadDomainClient } from "./DomainRead.ts";
import type { WriteDomainClient } from "./DomainWrite.ts";

/**
 * Runtime client with full access to a domain's REST data plane — everything
 * on {@link ReadDomainClient} and {@link WriteDomainClient} plus a raw
 * any-method escape hatch.
 */
export interface ReadWriteDomainClient
  extends ReadDomainClient, WriteDomainClient {
  /**
   * Raw escape hatch — a SigV4-signed request with any method against any
   * data-plane path (e.g. `PUT /my-index` to create an index with explicit
   * mappings, or `POST /_reindex`).
   */
  request(
    method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    options?: {
      /** Query-string parameters. */
      query?: Record<string, string | undefined>;
      /** JSON body (sent as `application/json`). */
      body?: unknown;
    },
  ): Effect.Effect<unknown, OpenSearchApiError | Credentials.CredentialsError>;
}

/**
 * Runtime binding for full read/write access to an OpenSearch
 * {@link Domain}'s REST data plane (IAM action `es:ESHttp*` on the domain
 * and its paths).
 *
 * Every request is a SigV4-signed HTTP call (service `es`) against the
 * domain's endpoint, made with the host Function's own credentials — the
 * domain's access policy must allow the function's role. Prefer the
 * least-privilege `DomainRead` / `DomainWrite` bindings when one direction
 * suffices. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DomainReadWriteHttp)`.
 * @binding
 * @section Reading and Writing a Domain
 * @example Index Then Search
 * ```typescript
 * // init — grants es:ESHttp* on the domain
 * const client = yield* AWS.OpenSearch.DomainReadWrite(domain);
 *
 * // runtime
 * yield* client.indexDocument(
 *   "songs",
 *   { title: "The Wind Cries Mary" },
 *   { id: "1", refresh: true },
 * );
 * const result = yield* client.search({
 *   index: "songs",
 *   body: { query: { match: { title: "wind" } } },
 * });
 * ```
 *
 * @example Create an Index With Explicit Mappings
 * ```typescript
 * yield* client.request("PUT", "songs", {
 *   body: { mappings: { properties: { title: { type: "text" } } } },
 * });
 * ```
 */
export interface DomainReadWrite extends Binding.Service<
  DomainReadWrite,
  "AWS.OpenSearch.DomainReadWrite",
  (domain: Domain) => Effect.Effect<ReadWriteDomainClient>
> {}
export const DomainReadWrite = Binding.Service<DomainReadWrite>(
  "AWS.OpenSearch.DomainReadWrite",
);
