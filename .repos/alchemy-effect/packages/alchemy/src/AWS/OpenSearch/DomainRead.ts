import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type {
  CountRequest,
  CountResponse,
  GetDocumentResponse,
  OpenSearchApiError,
  SearchRequest,
  SearchResponse,
} from "./DataPlaneTypes.ts";
import type { Domain } from "./Domain.ts";

/** Runtime client for read-only access to a domain's REST data plane. */
export interface ReadDomainClient {
  /**
   * Run a Query-DSL search (`GET …/_search`). The body travels in the
   * `source` query parameter so the request stays on `es:ESHttpGet` — no
   * write-method IAM action is required to search.
   */
  search<TDoc = unknown>(
    request?: SearchRequest,
  ): Effect.Effect<
    SearchResponse<TDoc>,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /** Count documents matching a Query-DSL body (`GET …/_count`). */
  count(
    request?: CountRequest,
  ): Effect.Effect<
    CountResponse,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /**
   * Fetch one document by id (`GET /{index}/_doc/{id}`). A missing document
   * is not an error — the response carries `found: false`.
   */
  getDocument<TDoc = unknown>(
    index: string,
    id: string,
  ): Effect.Effect<
    GetDocumentResponse<TDoc>,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /** Check whether a document exists (`HEAD /{index}/_doc/{id}`). */
  existsDocument(
    index: string,
    id: string,
  ): Effect.Effect<boolean, OpenSearchApiError | Credentials.CredentialsError>;
  /**
   * Raw read-only escape hatch — a SigV4-signed `GET` against any data-plane
   * path (e.g. `_cluster/health`, `_cat/indices?format=json`).
   */
  get(
    path: string,
    query?: Record<string, string | undefined>,
  ): Effect.Effect<unknown, OpenSearchApiError | Credentials.CredentialsError>;
}

/**
 * Runtime binding for read-only access to an OpenSearch {@link Domain}'s
 * REST data plane (IAM actions `es:ESHttpGet` and `es:ESHttpHead` on the
 * domain and its paths).
 *
 * Every request is a SigV4-signed HTTP call (service `es`) against the
 * domain's endpoint, made with the host Function's own credentials — the
 * domain's access policy must allow the function's role. Provide the
 * implementation with `Effect.provide(AWS.OpenSearch.DomainReadHttp)`.
 * @binding
 * @section Searching a Domain
 * @example Search Documents
 * ```typescript
 * // init — grants es:ESHttpGet/es:ESHttpHead on the domain
 * const search = yield* AWS.OpenSearch.DomainRead(domain);
 *
 * // runtime
 * const result = yield* search.search<{ title: string }>({
 *   index: "songs",
 *   body: { query: { match: { title: "wind" } } },
 * });
 * const titles = result.hits.hits.map((hit) => hit._source.title);
 * ```
 *
 * @example Fetch One Document
 * ```typescript
 * const doc = yield* search.getDocument<{ title: string }>("songs", "1");
 * if (doc.found) yield* Effect.log(doc._source?.title);
 * ```
 */
export interface DomainRead extends Binding.Service<
  DomainRead,
  "AWS.OpenSearch.DomainRead",
  (domain: Domain) => Effect.Effect<ReadDomainClient>
> {}
export const DomainRead = Binding.Service<DomainRead>(
  "AWS.OpenSearch.DomainRead",
);
