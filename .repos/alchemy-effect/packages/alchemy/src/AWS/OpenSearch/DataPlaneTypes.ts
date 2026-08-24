import * as Data from "effect/Data";

/**
 * Error returned by an OpenSearch domain's REST data plane (the search/index
 * API served under the domain's `endpoint`).
 *
 * Raised when the HTTP request fails, the response is not a 2xx (and not an
 * expected `404` on document lookups), or the body is not valid JSON.
 */
export class OpenSearchApiError extends Data.TaggedError(
  "AWS.OpenSearch.ApiError",
)<{
  /** HTTP method of the failed request. */
  readonly method: string;
  /** Path relative to the domain endpoint. */
  readonly path: string;
  /** HTTP status code (`0` when the request never produced a response). */
  readonly status: number;
  /** Raw response body (or the underlying failure message). */
  readonly body: string;
}> {}

/** How the `refresh` query parameter is sent on document writes. */
export type RefreshOption = boolean | "wait_for";

/** One search hit: index, id, relevance score, and the stored document. */
export interface SearchHit<TDoc = unknown> {
  _index: string;
  _id: string;
  _score: number | null;
  _source: TDoc;
}

/** Request for {@link ReadDomainClient.search}. */
export interface SearchRequest {
  /** Index (or comma-separated indices) to search. Omit to search all. */
  index?: string;
  /**
   * Query DSL body, e.g. `{ query: { match: { title: "wind" } } }`. Sent via
   * the `source` query parameter so the search stays on `es:ESHttpGet`.
   */
  body?: unknown;
  /** Extra query-string parameters (e.g. `{ size: "5" }`). */
  query?: Record<string, string | undefined>;
}

/** Response envelope of the `_search` API. */
export interface SearchResponse<TDoc = unknown> {
  took: number;
  timed_out: boolean;
  hits: {
    total: { value: number; relation: string };
    max_score: number | null;
    hits: Array<SearchHit<TDoc>>;
  };
  aggregations?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Request for {@link ReadDomainClient.count}. */
export interface CountRequest {
  /** Index (or comma-separated indices) to count in. Omit to count all. */
  index?: string;
  /** Query DSL body restricting which documents are counted. */
  body?: unknown;
}

/** Response of the `_count` API. */
export interface CountResponse {
  count: number;
  [key: string]: unknown;
}

/** Response of a `GET /{index}/_doc/{id}` lookup. */
export interface GetDocumentResponse<TDoc = unknown> {
  _index: string;
  _id: string;
  _version?: number;
  /** Whether the document exists (`false` on a 404 lookup). */
  found: boolean;
  _source?: TDoc;
  [key: string]: unknown;
}

/** Options for {@link WriteDomainClient.indexDocument}. */
export interface IndexDocumentOptions {
  /** Document id. Omit to let OpenSearch auto-generate one (`POST`). */
  id?: string;
  /** Refresh behavior — `true`, `false`, or `"wait_for"`. */
  refresh?: RefreshOption;
}

/** Response of a document index/create/update/delete write. */
export interface WriteDocumentResponse {
  _index: string;
  _id: string;
  _version?: number;
  /** e.g. `"created"`, `"updated"`, `"deleted"`, `"not_found"`. */
  result: string;
  [key: string]: unknown;
}

/** Options for document writes that support `refresh`. */
export interface WriteDocumentOptions {
  /** Refresh behavior — `true`, `false`, or `"wait_for"`. */
  refresh?: RefreshOption;
}

/** Response envelope of the `_bulk` API. */
export interface BulkResponse {
  took: number;
  /** Whether any item in the bulk request failed. */
  errors: boolean;
  items: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
