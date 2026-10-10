import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DatacatalogNotResolved,
  OWNERSHIP_FIELD_ID,
  desiredFields,
  fieldBody,
  fieldNeedsReplace,
  fingerprint,
  hasOwnershipMarker,
  ignoreGone,
  locationParent,
  missingGet,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  retryTransient,
  sameBool,
  sameJson,
  sameText,
  toTagTemplateId,
  updateMaskOf,
  userFields,
  type TagTemplateField,
  type TagTemplateFieldMap,
} from "./internal.ts";
import { createInternalLabels } from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export type TagTemplateFieldType =
  datacatalog.GoogleCloudDatacatalogV1FieldType;
export type { TagTemplateField, TagTemplateFieldMap };

export type TagTemplateProps = {
  /**
   * Tag template id (the `{tagTemplate}` segment of
   * `projects/{project}/locations/{location}/tagTemplates/{tagTemplate}`).
   * If omitted, a unique id is generated. Must contain only lowercase
   * letters, numbers, or underscores, start with a letter or underscore,
   * and be at most 64 bytes. Immutable — changing it replaces the
   * template.
   */
  tagTemplateId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the template. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Display name (Unicode letters, numbers, underscores, dashes, spaces;
   * max 200 characters).
   */
  displayName?: string;
  /**
   * When true, tags created with this template are publicly readable.
   * @default false
   */
  isPubliclyReadable?: boolean;
  /**
   * Map of field id to field settings. At least one field is required by
   * the API; Alchemy always adds a reserved `alchemy_ownership` STRING
   * field (stripped from attributes) so an empty map is valid. Field ids
   * may contain letters, numbers, and underscores (max 64).
   */
  fields?: TagTemplateFieldMap;
};

export type TagTemplate = Resource<
  "GCP.DataCatalog.TagTemplate",
  TagTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Tag template id (last path segment). */
    tagTemplateId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Whether tags created with this template are publicly readable. */
    isPubliclyReadable: boolean;
    /** User fields (Alchemy ownership field stripped). */
    fields: TagTemplateFieldMap;
    /** Dataplex transfer status, if any. */
    dataplexTransferStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Catalog tag template — a schema for tags attached to catalog
 * entries.
 *
 * Tag templates have no labels field. Alchemy stamps ownership into a
 * reserved `alchemy_ownership` field description so `list` / nuke can
 * identify owned templates. Id and location are immutable. Display name,
 * public readability, and fields update in place (field types other than
 * adding enum values require deleting and recreating the field).
 *
 * ### Creating a Tag Template
 * **Example:** Generated id with a string field
 * ```typescript
 * const template = yield* GCP.DataCatalog.TagTemplate("Source", {
 *   displayName: "Source",
 *   fields: {
 *     origin: {
 *       displayName: "Origin",
 *       type: { primitiveType: "STRING" },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const template = yield* GCP.DataCatalog.TagTemplate("Source", {
 *   tagTemplateId: "source_template",
 *   location: "us-central1",
 *   displayName: "Source",
 * });
 * ```
 *
 * ### Updating a Tag Template
 * **Example:** Display name and fields
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const template = yield* GCP.DataCatalog.TagTemplate("Source", {
 *   displayName: "Source v2",
 *   fields: {
 *     origin: {
 *       displayName: "Origin system",
 *       type: { primitiveType: "STRING" },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category DataCatalog
 */
export const TagTemplate = Resource<TagTemplate>("GCP.DataCatalog.TagTemplate");

const resourceName = (
  project: string,
  location: string,
  tagTemplateId: string,
) => `${locationParent(project, location)}/tagTemplates/${tagTemplateId}`;

const ownershipText = (
  template: datacatalog.GoogleCloudDatacatalogV1TagTemplate,
) => template.fields?.[OWNERSHIP_FIELD_ID]?.description;

const toAttrs = (
  template: datacatalog.GoogleCloudDatacatalogV1TagTemplate,
  project: string,
  region: string,
) => {
  const name = template.name ?? "";
  const parsed = parseName(name, "tagTemplates", region);
  return {
    name,
    tagTemplateId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: template.displayName,
    isPubliclyReadable: template.isPubliclyReadable === true,
    fields: userFields(template.fields),
    dataplexTransferStatus: template.dataplexTransferStatus,
  };
};

const getByName = missingGet(datacatalog.getProjectsLocationsTagTemplates);

const searchTemplateNames = (project: string) =>
  Effect.gen(function* () {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = yield* retryTransient(
        datacatalog.searchCatalog({
          body: {
            scope: { includeProjectIds: [project] },
            query: "type=tag_template",
            pageSize: 1000,
            pageToken,
            orderBy: "default",
          },
        }),
      );
      for (const result of page.results ?? []) {
        const name = result.relativeResourceName;
        if (
          name &&
          (result.searchResultType === "TAG_TEMPLATE" ||
            (result.searchResultSubtype ?? "").includes("tagTemplate"))
        ) {
          names.push(name);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && pageToken.length > 0);
    return names;
  });

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const names = yield* searchTemplateNames(project);
    const templates = yield* Effect.forEach(names, (name) => getByName(name), {
      concurrency: 4,
    });
    return templates.filter(
      (template): template is datacatalog.GoogleCloudDatacatalogV1TagTemplate =>
        template !== undefined && hasOwnershipMarker(ownershipText(template)),
    );
  });

const syncFields = (
  templateName: string,
  observed: TagTemplateFieldMap | undefined,
  desired: TagTemplateFieldMap,
) =>
  Effect.gen(function* () {
    const current = observed ?? {};
    const desiredIds = Object.keys(desired);
    const currentIds = Object.keys(current);

    for (const fieldId of desiredIds) {
      const next = desired[fieldId];
      if (next === undefined) continue;
      const previous = current[fieldId];
      if (previous === undefined) {
        yield* retryTransient(
          datacatalog.createProjectsLocationsTagTemplatesFields({
            parent: templateName,
            tagTemplateFieldId: fieldId,
            body: fieldBody(next),
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.void));
        continue;
      }
      if (fieldNeedsReplace(previous, next)) {
        yield* retryTransient(
          datacatalog.deleteProjectsLocationsTagTemplatesFields({
            name: `${templateName}/fields/${fieldId}`,
            force: true,
          }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* retryTransient(
          datacatalog.createProjectsLocationsTagTemplatesFields({
            parent: templateName,
            tagTemplateFieldId: fieldId,
            body: fieldBody(next),
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.void));
        continue;
      }
      const displayChanged = !sameText(previous.displayName, next.displayName);
      const requiredChanged = !sameBool(previous.isRequired, next.isRequired);
      const descriptionChanged = !sameText(
        previous.description,
        next.description,
      );
      const orderChanged = (previous.order ?? 0) !== (next.order ?? 0);
      const enumChanged =
        fingerprint(previous.type?.enumType) !==
        fingerprint(next.type?.enumType);
      if (
        !displayChanged &&
        !requiredChanged &&
        !descriptionChanged &&
        !orderChanged &&
        !enumChanged
      ) {
        continue;
      }
      yield* retryTransient(
        datacatalog.patchProjectsLocationsTagTemplatesFields({
          name: `${templateName}/fields/${fieldId}`,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            enumChanged ? "type.enum_type" : undefined,
            requiredChanged ? "is_required" : undefined,
            descriptionChanged ? "description" : undefined,
            orderChanged ? "order" : undefined,
          ),
          body: fieldBody(next),
        }),
      ).pipe(Effect.catchTag("BadRequest", () => Effect.void));
    }

    for (const fieldId of currentIds) {
      if (desired[fieldId] !== undefined) continue;
      yield* retryTransient(
        datacatalog.deleteProjectsLocationsTagTemplatesFields({
          name: `${templateName}/fields/${fieldId}`,
          force: true,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const TagTemplateProvider = () =>
  Provider.succeed(TagTemplate, {
    stables: ["name", "tagTemplateId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.tagTemplateId ?? output?.tagTemplateId,
        nextId:
          news.tagTemplateId ?? olds?.tagTemplateId ?? output?.tagTemplateId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tagTemplateId = yield* toTagTemplateId(
        id,
        olds?.tagTemplateId,
        output?.tagTemplateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, tagTemplateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const tagTemplateId = yield* toTagTemplateId(
        id,
        news.tagTemplateId,
        output?.tagTemplateId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, tagTemplateId);
      const ownership = yield* createInternalLabels(id);
      const fields = desiredFields(ownership, news.fields);
      const isPubliclyReadable = news.isPubliclyReadable === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          datacatalog.createProjectsLocationsTagTemplates({
            parent: locationParent(env.project, location),
            tagTemplateId,
            body: {
              displayName: news.displayName,
              isPubliclyReadable: isPubliclyReadable ? true : undefined,
              fields,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatacatalogNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, news.displayName);
      const publicChanged = !sameBool(
        current.isPubliclyReadable,
        isPubliclyReadable,
      );

      if (displayChanged || publicChanged) {
        current = yield* retryTransient(
          datacatalog.patchProjectsLocationsTagTemplates({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              publicChanged ? "is_publicly_readable" : undefined,
            ),
            body: {
              name: currentName,
              displayName: news.displayName,
              isPubliclyReadable: isPubliclyReadable ? true : undefined,
            },
          }),
        );
      }

      if (
        !sameJson(userFields(current.fields), userFields(fields)) ||
        parseOwnership(ownershipText(current)).labels["alchemy-id"] !==
          ownership["alchemy-id"]
      ) {
        yield* syncFields(currentName, current.fields, fields);
        current = (yield* getByName(currentName)) ?? current;
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        datacatalog
          .deleteProjectsLocationsTagTemplates({
            name: output.name,
            force: true,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "Conflict" || isTransientGcpError(error),
              times: 8,
              schedule: Schedule.exponential("500 millis"),
            }),
          ),
      );
    }),
  });
