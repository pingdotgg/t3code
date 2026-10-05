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
  MAX_DOCUMENT_ID_LENGTH,
  branchParent,
  parentOf,
  parseResourceName,
  rfc1035,
  sameJson,
  toPhysical,
} from "./internal.ts";

export type DocumentContent = {
  /** MIME type of `rawBytes` or the object at `uri`. */
  mimeType?: string;
  /** GCS URI (`gs://bucket/path`). */
  uri?: string;
  /** Base64-encoded bytes. Max 1,000,000 bytes. */
  rawBytes?: string;
};

export type CollectionsDataStoresBranchesDocumentProps = {
  /**
   * Parent data store resource name
   * `projects/{project}/locations/{location}/collections/{collection}/dataStores/{data_store}`.
   * Immutable — changing it replaces the document.
   */
  dataStore: string;
  /**
   * Branch id. Immutable.
   * @default "default_branch"
   */
  branchId?: string;
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
   * Structured document payload.
   */
  structData?: Record<string, unknown>;
  /**
   * Unstructured content. Required when the parent data store uses
   * `CONTENT_REQUIRED`.
   */
  content?: DocumentContent;
  /**
   * Parent document id (RFC-1034, max 63 characters).
   */
  parentDocumentId?: string;
  /**
   * Schema id in the same data store.
   */
  schemaId?: string;
};

export type CollectionsDataStoresBranchesDocument = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument",
  CollectionsDataStoresBranchesDocumentProps,
  {
    /** Full resource name. */
    name: string;
    /** Document id. */
    documentId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Branch id. */
    branchId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON payload. */
    jsonData: string | undefined;
    /** Structured payload. */
    structData: Record<string, unknown> | undefined;
    /** Unstructured content. */
    content: DocumentContent | undefined;
    /** Parent document id. */
    parentDocumentId: string | undefined;
    /** Schema id. */
    schemaId: string | undefined;
    /** Last index time. */
    indexTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine document under a collection data store branch.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent data store, branch, and document id are immutable. Payload fields
 * update in place.
 *
 * ### Creating a Document
 * **Example:** JSON document on the default branch
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {});
 * const doc = yield* GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument(
 *   "Intro",
 *   {
 *     dataStore: store.name,
 *     jsonData: JSON.stringify({ title: "Getting started" }),
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresBranchesDocument =
  Resource<CollectionsDataStoresBranchesDocument>(
    "GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument",
  );

export class CollectionsDataStoresBranchesDocumentNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocumentNotResolved",
)<{
  name: string;
}> {}

const contentOf = (
  content:
    | discoveryengine.GoogleCloudDiscoveryengineV1DocumentContent
    | undefined,
): DocumentContent | undefined =>
  content === undefined
    ? undefined
    : {
        mimeType: content.mimeType,
        uri: content.uri,
        rawBytes: content.rawBytes,
      };

const toAttrs = (
  document: discoveryengine.GoogleCloudDiscoveryengineV1Document,
  project: string,
) => {
  const name = document.name ?? "";
  const parsed = parseResourceName(name, "documents");
  const branches = parseResourceName(name, "branches");
  return {
    name,
    documentId: document.id ?? parsed.id,
    dataStore: parentOf(name, "branches"),
    branchId: branches.id,
    project: parsed.project || project,
    location: parsed.location,
    jsonData: document.jsonData,
    structData: document.structData as Record<string, unknown> | undefined,
    content: contentOf(document.content),
    parentDocumentId: document.parentDocumentId,
    schemaId: document.schemaId,
    indexTime: document.indexTime,
  };
};

const resourceName = (
  dataStore: string,
  branchId: string,
  documentId: string,
) => `${branchParent(dataStore, branchId)}/documents/${documentId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresBranchesDocuments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CollectionsDataStoresBranchesDocumentProvider = () =>
  Provider.succeed(CollectionsDataStoresBranchesDocument, {
    stables: [
      "name",
      "documentId",
      "dataStore",
      "branchId",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousBranch =
        olds?.branchId ?? output?.branchId ?? DEFAULT_BRANCH;
      const nextBranch = news.branchId ?? previousBranch;
      const previousId = olds?.documentId ?? output?.documentId;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        previousBranch !== nextBranch ||
        (previousId !== undefined &&
          news.documentId !== undefined &&
          news.documentId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousBranch === nextBranch &&
            previousId !== undefined &&
            news.documentId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const branchId = olds?.branchId ?? output?.branchId ?? DEFAULT_BRANCH;
      const documentId = yield* toPhysical(
        id,
        olds?.documentId,
        output?.documentId,
        (name) => rfc1035(name, MAX_DOCUMENT_ID_LENGTH),
        MAX_DOCUMENT_ID_LENGTH,
      );
      const name =
        output?.name ??
        (dataStore !== undefined
          ? resourceName(dataStore, branchId, documentId)
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const branchId = news.branchId ?? output?.branchId ?? DEFAULT_BRANCH;
      const documentId = yield* toPhysical(
        id,
        news.documentId,
        output?.documentId,
        (name) => rfc1035(name, MAX_DOCUMENT_ID_LENGTH),
        MAX_DOCUMENT_ID_LENGTH,
      );
      const name = resourceName(news.dataStore, branchId, documentId);
      const jsonData = news.jsonData;
      const parent = branchParent(news.dataStore, branchId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresBranchesDocuments({
            parent,
            documentId,
            body: {
              jsonData,
              structData: news.structData,
              content: news.content,
              parentDocumentId: news.parentDocumentId,
              schemaId: news.schemaId,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresBranchesDocumentNotResolved({
          name,
        });
      }

      const resource = current.name ?? name;
      const jsonChanged =
        jsonData !== undefined && (current.jsonData ?? "") !== jsonData;
      const structChanged = !sameJson(current.structData, news.structData);
      const contentChanged = !sameJson(
        contentOf(current.content),
        news.content,
      );
      const parentChanged =
        (current.parentDocumentId ?? "") !== (news.parentDocumentId ?? "");
      const schemaChanged = (current.schemaId ?? "") !== (news.schemaId ?? "");

      if (
        jsonChanged ||
        structChanged ||
        contentChanged ||
        parentChanged ||
        schemaChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresBranchesDocuments(
            {
              name: resource,
              body: {
                name: resource,
                jsonData,
                structData: news.structData,
                content: news.content,
                parentDocumentId: news.parentDocumentId,
                schemaId: news.schemaId,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresBranchesDocuments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
