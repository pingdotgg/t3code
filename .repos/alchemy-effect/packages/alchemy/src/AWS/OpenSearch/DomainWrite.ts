import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type {
  BulkResponse,
  IndexDocumentOptions,
  OpenSearchApiError,
  WriteDocumentOptions,
  WriteDocumentResponse,
} from "./DataPlaneTypes.ts";
import type { Domain } from "./Domain.ts";

/** Runtime client for write access to a domain's REST data plane. */
export interface WriteDomainClient {
  /**
   * Index (upsert) one document — `PUT /{index}/_doc/{id}` when an id is
   * given, `POST /{index}/_doc` (auto-generated id) otherwise.
   */
  indexDocument(
    index: string,
    document: unknown,
    options?: IndexDocumentOptions,
  ): Effect.Effect<
    WriteDocumentResponse,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /**
   * Partially update one document (`POST /{index}/_update/{id}`). The body
   * is the update API's envelope, e.g. `{ doc: { plays: 42 } }`.
   */
  updateDocument(
    index: string,
    id: string,
    body: unknown,
    options?: WriteDocumentOptions,
  ): Effect.Effect<
    WriteDocumentResponse,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /**
   * Delete one document (`DELETE /{index}/_doc/{id}`). Deleting a missing
   * document is not an error — the response carries `result: "not_found"`.
   */
  deleteDocument(
    index: string,
    id: string,
    options?: WriteDocumentOptions,
  ): Effect.Effect<
    WriteDocumentResponse,
    OpenSearchApiError | Credentials.CredentialsError
  >;
  /**
   * Bulk-apply index/create/update/delete operations (`POST /_bulk`). Pass
   * the action/document lines as an array — they are serialized to NDJSON.
   */
  bulk(
    operations: ReadonlyArray<unknown>,
    options?: WriteDocumentOptions,
  ): Effect.Effect<
    BulkResponse,
    OpenSearchApiError | Credentials.CredentialsError
  >;
}

/**
 * Runtime binding for write access to an OpenSearch {@link Domain}'s REST
 * data plane (IAM actions `es:ESHttpPut`, `es:ESHttpPost`, `es:ESHttpDelete`
 * and `es:ESHttpPatch` on the domain and its paths).
 *
 * Every request is a SigV4-signed HTTP call (service `es`) against the
 * domain's endpoint, made with the host Function's own credentials — the
 * domain's access policy must allow the function's role. Provide the
 * implementation with `Effect.provide(AWS.OpenSearch.DomainWriteHttp)`.
 * @binding
 * @section Writing Documents
 * @example Index and Delete Documents
 * ```typescript
 * // init — grants es:ESHttpPut/Post/Delete/Patch on the domain
 * const writer = yield* AWS.OpenSearch.DomainWrite(domain);
 *
 * // runtime
 * yield* writer.indexDocument(
 *   "songs",
 *   { title: "The Wind Cries Mary" },
 *   { id: "1", refresh: true },
 * );
 * yield* writer.deleteDocument("songs", "1", { refresh: true });
 * ```
 */
export interface DomainWrite extends Binding.Service<
  DomainWrite,
  "AWS.OpenSearch.DomainWrite",
  (domain: Domain) => Effect.Effect<WriteDomainClient>
> {}
export const DomainWrite = Binding.Service<DomainWrite>(
  "AWS.OpenSearch.DomainWrite",
);
