import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  LIST_LOCATIONS,
  appendProperties,
  collectPages,
  defaultTextProperty,
  encodeOwnership,
  ensureProject,
  hasOwnershipMarker,
  ignoreList,
  lastSegment,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
  ResourceNotResolved,
} from "./internal.ts";

export type PropertyDefinition =
  cw.GoogleCloudContentwarehouseV1PropertyDefinition;

export type DocumentSchemaProps = {
  /**
   * Document schema id (the `{documentSchema}` segment of
   * `projects/{project}/locations/{location}/documentSchemas/{documentSchema}`).
   * Assigned by the API on create. Immutable — changing it replaces the
   * schema. Supply it to adopt an existing schema.
   */
  documentSchemaId?: string;
  /**
   * Multi-region location (`us` or `eu`). Immutable — changing it
   * replaces the schema. `US` is accepted and normalized to `us`.
   * @default "us"
   */
  location?: string;
  /**
   * Unique display name within the project. Defaults to a generated id.
   */
  displayName?: string;
  /**
   * Schema description. Document schemas have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * When true the schema describes a folder rather than a document.
   * @default false
   */
  documentIsFolder?: boolean;
  /**
   * Property definitions. Updates may only append new properties — existing
   * definitions cannot be mutated in place.
   */
  propertyDefinitions?: PropertyDefinition[];
};

export type DocumentSchema = Resource<
  "GCP.ContentWarehouse.DocumentSchema",
  DocumentSchemaProps,
  {
    /** Full resource name. */
    name: string;
    /** Document schema id (last path segment). */
    documentSchemaId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether this schema describes a folder. */
    documentIsFolder: boolean;
    /** Property definitions. */
    propertyDefinitions: PropertyDefinition[] | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Document AI Warehouse document schema describing document structure.
 *
 * Schemas have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Location is immutable.
 * Description and newly appended properties update in place; existing
 * property definitions cannot be rewritten.
 *
 * The project must be initialized for Document AI Warehouse in `us` or
 * `eu` before schemas can be created.
 *
 * ### Creating a Document Schema
 * **Example:** Text document schema
 * ```typescript
 * const schema = yield* GCP.ContentWarehouse.DocumentSchema("Invoice", {
 *   displayName: "invoice",
 *   propertyDefinitions: [
 *     { name: "title", isSearchable: true, textTypeOptions: {} },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ContentWarehouse
 */
export const DocumentSchema = Resource<DocumentSchema>(
  "GCP.ContentWarehouse.DocumentSchema",
);

const resourceName = (
  project: string,
  location: string,
  documentSchemaId: string,
) => `${locationParent(project, location)}/documentSchemas/${documentSchemaId}`;

const toAttrs = (
  item: cw.GoogleCloudContentwarehouseV1DocumentSchema,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "documentSchemas");
  return {
    name,
    documentSchemaId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    description: parseOwnership(item.description).text,
    documentIsFolder: item.documentIsFolder === true,
    propertyDefinitions: item.propertyDefinitions,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cw
        .getProjectsLocationsDocumentSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  collectPages(
    cw.listProjectsLocationsDocumentSchemas.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.documentSchemas,
  ).pipe(ignoreList([] as cw.GoogleCloudContentwarehouseV1DocumentSchema[]));

const findOwned = (
  id: string,
  items: readonly cw.GoogleCloudContentwarehouseV1DocumentSchema[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.description)) return item;
    }
    return undefined as
      | cw.GoogleCloudContentwarehouseV1DocumentSchema
      | undefined;
  });

const listOwned = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) => listAt(locationParent(project, location)),
    { concurrency: 2 },
  ).pipe(
    Effect.map((groups) =>
      groups.flat().filter((item) => hasOwnershipMarker(item.description)),
    ),
  );

export const DocumentSchemaProvider = () =>
  Provider.succeed(DocumentSchema, {
    stables: ["name", "documentSchemaId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const folderChanged =
        (olds?.documentIsFolder ?? output?.documentIsFolder ?? false) !==
        (news.documentIsFolder ?? false);
      return replaceOnIdentity({
        previousId: olds?.documentSchemaId ?? output?.documentSchemaId,
        nextId: news.documentSchemaId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra: folderChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const documentSchemaId =
        olds?.documentSchemaId ?? output?.documentSchemaId;
      const name =
        output?.name ??
        (documentSchemaId
          ? resourceName(env.project, location, documentSchemaId)
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        const listed = yield* listAt(locationParent(env.project, location));
        existing = yield* findOwned(id, listed);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
      yield* ensureProject(parent);
      const documentSchemaId = yield* toPhysicalId(
        id,
        news.documentSchemaId,
        output?.documentSchemaId,
        "schema",
      );
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? documentSchemaId;
      const propertyDefinitions = news.propertyDefinitions ?? [
        defaultTextProperty(),
      ];
      const documentIsFolder = news.documentIsFolder === true;

      const findInParent = listAt(parent).pipe(
        Effect.flatMap((items) => findOwned(id, items)),
      );
      let current =
        (yield* getByName(output?.name ?? "")) ?? (yield* findInParent);

      if (current === undefined) {
        const created = yield* cw
          .createProjectsLocationsDocumentSchemas({
            parent,
            body: {
              displayName,
              description,
              documentIsFolder,
              propertyDefinitions,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? (yield* findInParent);
        if (current === undefined) {
          current = yield* waitUntilExists(
            Effect.flatMap(listAt(parent), (items) => findOwned(id, items)),
            `${parent}/documentSchemas/${documentSchemaId}`,
          );
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name:
            output?.name ??
            resourceName(env.project, location, documentSchemaId),
        });
      }

      const currentName = current.name ?? "";
      const appended = appendProperties(
        current.propertyDefinitions,
        propertyDefinitions,
      );
      const descriptionChanged = !sameText(current.description, description);
      const displayChanged = !sameText(current.displayName, displayName);
      if (descriptionChanged || displayChanged || appended.appended) {
        current = yield* cw.patchProjectsLocationsDocumentSchemas({
          name: currentName,
          body: {
            documentSchema: {
              name: currentName,
              displayName,
              description,
              documentIsFolder,
              propertyDefinitions: appended.properties,
            },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cw
        .deleteProjectsLocationsDocumentSchemas({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

export const documentSchemaIdOf = lastSegment;
