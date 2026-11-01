import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_BRANCH,
  expandDataStore,
  fingerprint,
  MAX_DOCUMENT_ID_LENGTH,
  parseResourceName,
  rfc1035,
  toPhysical,
} from "./internal.ts";

export type DataStoresDocumentContent = {
  /**
   * MIME type (`text/plain`, `text/html`, `application/pdf`,
   * `application/json`, …).
   */
  mimeType?: string;
  /**
   * Cloud Storage URI (`gs://bucket/path`). Max 2.5 MB for text, 200 MB
   * otherwise.
   */
  uri?: string;
  /**
   * Raw bytes as a base64 string. Max 1,000,000 bytes.
   */
  rawBytes?: string;
};

export type DataStoresBranchesDocumentProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the document.
   */
  dataStore: string;
  /**
   * Branch id. Use `default_branch` for the default branch.
   * Immutable — changing it replaces the document.
   * @default "default_branch"
   */
  branch?: string;
  /**
   * Document id (RFC-1034, max 128 characters). If omitted, a unique id
   * is generated. Immutable — changing it replaces the document.
   */
  documentId?: string;
  /**
   * JSON document payload. Must conform to the data store schema.
   */
  jsonData?: string;
  /**
   * Structured document payload. Ignored when `jsonData` is set.
   */
  structData?: Record<string, unknown>;
  /**
   * Unstructured content. Required for `CONTENT_REQUIRED` data stores.
   */
  content?: DataStoresDocumentContent;
  /**
   * Parent document id for two-level hierarchies (RFC-1034, max 63).
   */
  parentDocumentId?: string;
  /**
   * Schema id in the same data store.
   */
  schemaId?: string;
};

export type DataStoresBranchesDocument = Resource<
  "GCP.DiscoveryEngine.DataStoresBranchesDocument",
  DataStoresBranchesDocumentProps,
  {
    /** Full resource name `.../branches/{branch}/documents/{document}`. */
    name: string;
    /** Document id (last path segment). */
    documentId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Branch id. */
    branch: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON payload. */
    jsonData: string | undefined;
    /** Structured payload, if set. */
    structData: Record<string, unknown> | undefined;
    /** Unstructured content, if set. */
    content: DataStoresDocumentContent | undefined;
    /** Parent document id, if set. */
    parentDocumentId: string | undefined;
    /** Schema id, if set. */
    schemaId: string | undefined;
    /** Last index timestamp, if indexed. */
    indexTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search Document in a Data Store branch.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent data store, branch, and document id are immutable; payload and
 * content update in place.
 *
 * ### Creating a Document
 * **Example:** JSON document on the default branch
 * ```typescript
 * const document = yield* GCP.DiscoveryEngine.DataStoresBranchesDocument(
 *   "About",
 *   {
 *     dataStore: dataStore.name,
 *     jsonData: JSON.stringify({
 *       title: "About us",
 *       uri: "https://example.com/about",
 *     }),
 *   },
 * );
 * ```
 *
 * ### Updating a Document
 * **Example:** Change the title
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const document = yield* GCP.DiscoveryEngine.DataStoresBranchesDocument(
 *   "About",
 *   {
 *     dataStore: dataStore.name,
 *     jsonData: JSON.stringify({
 *       title: "About the team",
 *       uri: "https://example.com/about",
 *     }),
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresBranchesDocument = Resource<DataStoresBranchesDocument>(
  "GCP.DiscoveryEngine.DataStoresBranchesDocument",
);

export class DataStoresBranchesDocumentNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresBranchesDocumentNotResolved",
)<{
  name: string;
}> {}

const branchParent = (dataStore: string, branch: string) =>
  `${dataStore}/branches/${branch}`;

const resourceName = (dataStore: string, branch: string, documentId: string) =>
  `${branchParent(dataStore, branch)}/documents/${documentId}`;

const toAttrs = (
  document: discoveryengine.GoogleCloudDiscoveryengineV1Document,
  project: string,
) => {
  const name = document.name ?? "";
  const parsed = parseResourceName(name, "documents");
  const branchParsed = parseResourceName(name, "branches");
  return {
    name,
    documentId: document.id ?? parsed.id,
    dataStore: parsed.dataStore,
    branch: branchParsed.id || DEFAULT_BRANCH,
    project: parsed.project || project,
    location: parsed.location,
    jsonData: document.jsonData,
    structData: document.structData as Record<string, unknown> | undefined,
    content: document.content
      ? {
          mimeType: document.content.mimeType,
          uri: document.content.uri,
          rawBytes: document.content.rawBytes,
        }
      : undefined,
    parentDocumentId: document.parentDocumentId,
    schemaId: document.schemaId,
    indexTime: document.indexTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresBranchesDocuments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DataStoresBranchesDocumentProvider = () =>
  Provider.succeed(DataStoresBranchesDocument, {
    stables: [
      "name",
      "documentId",
      "dataStore",
      "branch",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousBranch = olds?.branch ?? output?.branch ?? DEFAULT_BRANCH;
      const nextBranch = news.branch ?? previousBranch;
      if (previousBranch !== nextBranch) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.documentId ?? output?.documentId;
      if (
        previousId !== undefined &&
        news.documentId !== undefined &&
        news.documentId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const documentId = yield* toPhysical(
        id,
        olds?.documentId,
        output?.documentId,
        (name) => rfc1035(name, MAX_DOCUMENT_ID_LENGTH),
        MAX_DOCUMENT_ID_LENGTH,
      );
      const branch = olds?.branch ?? output?.branch ?? DEFAULT_BRANCH;
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ??
        (parent ? resourceName(parent, branch, documentId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const branch = news.branch ?? output?.branch ?? DEFAULT_BRANCH;
      const documentId = yield* toPhysical(
        id,
        news.documentId,
        output?.documentId,
        (name) => rfc1035(name, MAX_DOCUMENT_ID_LENGTH),
        MAX_DOCUMENT_ID_LENGTH,
      );
      const name = resourceName(parent, branch, documentId);
      const jsonData = news.jsonData;
      const body: discoveryengine.GoogleCloudDiscoveryengineV1Document = {
        id: documentId,
        jsonData,
        structData: news.jsonData === undefined ? news.structData : undefined,
        content: news.content,
        parentDocumentId: news.parentDocumentId,
        schemaId: news.schemaId,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresBranchesDocuments({
            parent: branchParent(parent, branch),
            documentId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresBranchesDocumentNotResolved({ name });
      }

      const jsonChanged =
        fingerprint(current.jsonData) !== fingerprint(jsonData);
      const structChanged =
        news.jsonData === undefined &&
        fingerprint(current.structData) !== fingerprint(news.structData);
      const contentChanged =
        fingerprint(current.content) !== fingerprint(news.content);
      const parentChanged =
        news.parentDocumentId !== undefined &&
        (current.parentDocumentId ?? "") !== news.parentDocumentId;
      const schemaChanged =
        news.schemaId !== undefined &&
        (current.schemaId ?? "") !== news.schemaId;

      if (
        jsonChanged ||
        structChanged ||
        contentChanged ||
        parentChanged ||
        schemaChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresBranchesDocuments(
            {
              name: current.name ?? name,
              allowMissing: true,
              updateMask: [
                jsonChanged ? "json_data" : undefined,
                structChanged ? "struct_data" : undefined,
                contentChanged ? "content" : undefined,
                parentChanged ? "parent_document_id" : undefined,
                schemaChanged ? "schema_id" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: { ...body, name: current.name ?? name },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresBranchesDocuments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
