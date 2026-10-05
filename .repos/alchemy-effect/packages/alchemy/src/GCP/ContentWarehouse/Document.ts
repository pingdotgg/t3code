import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ensureProject,
  lastSegment,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
  ResourceNotResolved,
} from "./internal.ts";

export type DocumentProperty = cw.GoogleCloudContentwarehouseV1Property;

export type DocumentProps = {
  /**
   * Document id (the `{document}` segment of
   * `projects/{project}/locations/{location}/documents/{document}`).
   * Assigned by the API on create. Immutable — changing it replaces the
   * document. Supply it to adopt an existing document.
   */
  documentId?: string;
  /**
   * Customer-assigned reference id, unique per project and location.
   * If omitted, a unique id is generated and used for lookup.
   * Immutable — changing it replaces the document.
   */
  referenceId?: string;
  /**
   * Multi-region location (`us` or `eu`). Immutable — changing it
   * replaces the document. `US` is accepted and normalized to `us`.
   * @default "us"
   */
  location?: string;
  /**
   * Parent document schema resource name
   * `projects/{project}/locations/{location}/documentSchemas/{schema}`.
   * Immutable — changing it replaces the document.
   */
  documentSchemaName: string;
  /**
   * Display name shown in the UI.
   * @default the document's `referenceId`
   */
  displayName?: string;
  /**
   * Title describing the document.
   */
  title?: string;
  /**
   * Inline plain-text content.
   */
  plainText?: string;
  /**
   * Cloud Storage path of the raw document (`gs://bucket/object`).
   */
  rawDocumentPath?: string;
  /**
   * URI used to display the document.
   */
  displayUri?: string;
  /**
   * Category of the original content (`CONTENT_CATEGORY_IMAGE`, …).
   */
  contentCategory?: string;
  /**
   * When true, skip text extraction on create.
   * @default true
   */
  textExtractionDisabled?: boolean;
  /**
   * User-supplied metadata properties matching the schema.
   */
  properties?: DocumentProperty[];
};

export type Document = Resource<
  "GCP.ContentWarehouse.Document",
  DocumentProps,
  {
    /** Full resource name. */
    name: string;
    /** Document id (last path segment). */
    documentId: string;
    /** Customer-assigned reference id. */
    referenceId: string | undefined;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Parent document schema resource name. */
    documentSchemaName: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Title. */
    title: string | undefined;
    /** Inline plain-text content. */
    plainText: string | undefined;
    /** Cloud Storage path of the raw document. */
    rawDocumentPath: string | undefined;
    /** Display URI. */
    displayUri: string | undefined;
    /** Content category. */
    contentCategory: string | undefined;
    /** User-supplied metadata properties. */
    properties: DocumentProperty[] | undefined;
    /** Creator. */
    creator: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Document AI Warehouse document — structured content plus metadata
 * that conforms to a {@link DocumentSchema}.
 *
 * Documents have no labels field, so Alchemy identifies a document by its
 * `referenceId`: one found under the generated id is adopted, one found
 * under an explicit `referenceId` without state is reported as unowned.
 * Location, schema, and
 * reference id are immutable. Display name, title, and plain text update
 * in place.
 *
 * ### Creating a Document
 * **Example:** Plain-text document
 * ```typescript
 * const schema = yield* GCP.ContentWarehouse.DocumentSchema("Note", {});
 * const document = yield* GCP.ContentWarehouse.Document("Welcome", {
 *   documentSchemaName: schema.name,
 *   displayName: "welcome",
 *   plainText: "hello warehouse",
 * });
 * ```
 *
 * @resource
 * @category ContentWarehouse
 */
export const Document = Resource<Document>("GCP.ContentWarehouse.Document");

const resourceName = (project: string, location: string, documentId: string) =>
  `${locationParent(project, location)}/documents/${documentId}`;

const referenceName = (
  project: string,
  location: string,
  referenceId: string,
) =>
  `${locationParent(project, location)}/documents/referenceId/${referenceId}`;

const toAttrs = (
  item: cw.GoogleCloudContentwarehouseV1Document,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "documents");
  const id = parsed.id === "referenceId" ? lastSegment(name) : parsed.id;
  return {
    name,
    documentId: id,
    referenceId: item.referenceId,
    project: parsed.project || project,
    location: parsed.location,
    documentSchemaName: item.documentSchemaName,
    displayName: item.displayName,
    title: item.title,
    plainText: item.plainText,
    rawDocumentPath: item.rawDocumentPath,
    displayUri: item.displayUri,
    contentCategory: item.contentCategory,
    properties: item.properties,
    creator: item.creator,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cw
        .getProjectsLocationsDocuments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DocumentProvider = () =>
  Provider.succeed(Document, {
    stables: [
      "name",
      "documentId",
      "referenceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const schemaChanged =
        (olds?.documentSchemaName ?? output?.documentSchemaName) !==
          undefined &&
        news.documentSchemaName !==
          (olds?.documentSchemaName ?? output?.documentSchemaName);
      return replaceOnIdentity({
        previousId: olds?.referenceId ?? output?.referenceId,
        nextId: news.referenceId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra: schemaChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const documentId = olds?.documentId ?? output?.documentId;
      const referenceId = olds?.referenceId ?? output?.referenceId;
      const name =
        output?.name ??
        (documentId
          ? resourceName(env.project, location, documentId)
          : referenceId
            ? referenceName(env.project, location, referenceId)
            : "");
      let existing = yield* getByName(name);
      if (existing === undefined && referenceId) {
        existing = yield* getByName(
          referenceName(env.project, location, referenceId),
        );
      }
      if (existing === undefined && output === undefined) {
        // No labels: a document is identified by its reference id.
        const generated = yield* toPhysicalId(id, undefined, undefined, "doc");
        existing = yield* getByName(
          referenceName(env.project, location, referenceId ?? generated),
        );
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project);
        return referenceId === undefined ? attrs : Unowned(attrs);
      }
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
      yield* ensureProject(parent);
      const referenceId = yield* toPhysicalId(
        id,
        news.referenceId,
        output?.referenceId,
        "doc",
      );
      const displayName = news.displayName ?? referenceId;
      const title = news.title ?? news.displayName ?? referenceId;
      const textExtractionDisabled = news.textExtractionDisabled ?? true;
      const lookup =
        output?.name ?? referenceName(env.project, location, referenceId);

      let current = yield* getByName(lookup);
      if (current === undefined) {
        current = yield* getByName(
          referenceName(env.project, location, referenceId),
        );
      }

      if (current === undefined) {
        const created = yield* cw
          .createProjectsLocationsDocuments({
            parent,
            body: {
              document: {
                displayName,
                title,
                plainText: news.plainText ?? title,
                documentSchemaName: news.documentSchemaName,
                referenceId,
                rawDocumentPath: news.rawDocumentPath,
                displayUri: news.displayUri,
                contentCategory: news.contentCategory,
                textExtractionDisabled,
                properties: news.properties,
              },
            },
          })
          .pipe(
            Effect.map((response) => response.document),
            Effect.catchTag("Conflict", () =>
              getByName(referenceName(env.project, location, referenceId)),
            ),
          );
        current =
          created ??
          (yield* waitUntilExists(
            getByName(referenceName(env.project, location, referenceId)),
            referenceName(env.project, location, referenceId),
          ));
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: lookup });
      }

      const currentName = current.name ?? lookup;
      const displayChanged = !sameText(current.displayName, displayName);
      const titleChanged = !sameText(current.title, title);
      const textChanged = !sameText(current.plainText, news.plainText ?? title);
      const uriChanged = !sameText(current.displayUri, news.displayUri);
      const pathChanged = !sameText(
        current.rawDocumentPath,
        news.rawDocumentPath,
      );
      const propertiesChanged = !sameJson(current.properties, news.properties);
      if (
        displayChanged ||
        titleChanged ||
        textChanged ||
        uriChanged ||
        pathChanged ||
        propertiesChanged
      ) {
        const updated = yield* cw.patchProjectsLocationsDocuments({
          name: currentName,
          body: {
            document: {
              name: currentName,
              displayName,
              title,
              plainText: news.plainText ?? title,
              documentSchemaName: news.documentSchemaName,
              referenceId,
              rawDocumentPath: news.rawDocumentPath,
              displayUri: news.displayUri,
              contentCategory: news.contentCategory,
              properties: news.properties,
            },
            updateOptions: {
              updateType: "UPDATE_TYPE_REPLACE",
            },
          },
        });
        current = updated.document ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cw
        .deleteProjectsLocationsDocuments({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
