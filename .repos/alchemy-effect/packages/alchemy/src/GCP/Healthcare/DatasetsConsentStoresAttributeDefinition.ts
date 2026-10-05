import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  expandParent,
  hasOwnershipMarker,
  listAlchemyConsentStores,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalSnake,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type DatasetsConsentStoresAttributeDefinitionProps = {
  /**
   * Parent consent store. Full name
   * `.../consentStores/{consentStore}` or the store id (combined with
   * `dataset` and `location`). Immutable — changing it replaces the
   * definition.
   */
  consentStore: string;
  /**
   * Parent dataset used when `consentStore` is a bare id.
   */
  dataset?: string;
  /**
   * Region used when `consentStore` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Attribute definition id. Must match letters, digits, and
   * underscores; cannot be a CEL reserved keyword. Immutable — changing
   * it replaces the definition.
   */
  attributeDefinitionId?: string;
  /**
   * Attribute category. Immutable — changing it replaces the definition.
   */
  category: healthcare.AttributeDefinitionCategoryEnum | (string & {});
  /**
   * Allowed values. The list can only be expanded after creation.
   */
  allowedValues: string[];
  /**
   * Human-readable description. Attribute definitions have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Default values applied to Consents that omit this attribute.
   */
  consentDefaultValues?: string[];
  /**
   * Default value applied to User data mappings (RESOURCE category).
   */
  dataMappingDefaultValue?: string;
};

export type DatasetsConsentStoresAttributeDefinition = Resource<
  "GCP.Healthcare.DatasetsConsentStoresAttributeDefinition",
  DatasetsConsentStoresAttributeDefinitionProps,
  {
    /** Full resource name `.../attributeDefinitions/{attributeDefinition}`. */
    name: string;
    /** Attribute definition id. */
    attributeDefinitionId: string;
    /** Parent consent store resource name. */
    consentStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Attribute category. */
    category: string;
    /** Allowed values. */
    allowedValues: string[];
    /** Description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Default Consent values. */
    consentDefaultValues: string[] | undefined;
    /** Default User data mapping value. */
    dataMappingDefaultValue: string | undefined;
  },
  never,
  Providers
>;

/**
 * A client-defined consent attribute in a consent store.
 *
 * Consent store, id, and category are immutable. Allowed values can only
 * grow. Description, consent defaults, and data-mapping default update
 * in place. Ownership is stamped into `description`.
 *
 * ### Creating an Attribute Definition
 * **Example:** Resource attribute
 * ```typescript
 * const attr = yield* GCP.Healthcare.DatasetsConsentStoresAttributeDefinition(
 *   "DataType",
 *   {
 *     consentStore: store.name,
 *     category: "RESOURCE",
 *     allowedValues: ["fhir", "dicom"],
 *     description: "data modality",
 *   },
 * );
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsConsentStoresAttributeDefinition =
  Resource<DatasetsConsentStoresAttributeDefinition>(
    "GCP.Healthcare.DatasetsConsentStoresAttributeDefinition",
  );

export class DatasetsConsentStoresAttributeDefinitionNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsConsentStoresAttributeDefinitionNotResolved",
)<{
  name: string;
}> {}

const storeOf = (
  consentStore: string,
  project: string,
  location: string,
  dataset: string | undefined,
) => {
  if (consentStore.includes("/")) return consentStore.replace(/\/+$/, "");
  if (dataset === undefined) {
    return expandParent(consentStore, project, location, "consentStores");
  }
  const datasetName = expandParent(dataset, project, location, "datasets");
  return `${datasetName}/consentStores/${consentStore}`;
};

const resourceName = (consentStore: string, attributeDefinitionId: string) =>
  `${consentStore}/attributeDefinitions/${attributeDefinitionId}`;

const toAttrs = (
  definition: healthcare.AttributeDefinition,
  project: string,
  region: string,
) => {
  const name = definition.name ?? "";
  const parsed = parseResourceName(name, "attributeDefinitions", region);
  const ownership = parseOwnership(definition.description);
  return {
    name,
    attributeDefinitionId: parsed.id,
    consentStore: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    category: definition.category ?? "CATEGORY_UNSPECIFIED",
    allowedValues: definition.allowedValues ?? [],
    description: ownership.text,
    consentDefaultValues: definition.consentDefaultValues,
    dataMappingDefaultValue: definition.dataMappingDefaultValue,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsConsentStoresAttributeDefinitions({
          name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsConsentStoresAttributeDefinitionProvider = () =>
  Provider.succeed(DatasetsConsentStoresAttributeDefinition, {
    stables: [
      "name",
      "attributeDefinitionId",
      "consentStore",
      "project",
      "location",
      "category",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousCategory = olds?.category ?? output?.category;
      const extra =
        previousCategory !== undefined && previousCategory !== news.category;
      return replaceOnIdentity({
        previousId:
          olds?.attributeDefinitionId ?? output?.attributeDefinitionId,
        nextId: news.attributeDefinitionId,
        previousParent: olds?.consentStore ?? output?.consentStore,
        nextParent: storeOf(
          news.consentStore,
          env.project,
          normalizeLocation(news.location ?? output?.location, env.region),
          news.dataset,
        ),
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const attributeDefinitionId = yield* toPhysicalSnake(
        id,
        olds?.attributeDefinitionId,
        output?.attributeDefinitionId,
      );
      const consentStore =
        olds?.consentStore !== undefined
          ? storeOf(olds.consentStore, env.project, location, olds.dataset)
          : (output?.consentStore ?? "");
      const name =
        output?.name ??
        (consentStore.length > 0
          ? resourceName(consentStore, attributeDefinitionId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listAlchemyConsentStores(env.project, env.region);
        const definitions = yield* Effect.forEach(
          stores,
          (store) =>
            collectPages(
              healthcare.listProjectsLocationsDatasetsConsentStoresAttributeDefinitions.pages(
                {
                  parent: store.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.attributeDefinitions,
            ),
          { concurrency: 4 },
        );
        return definitions
          .flat()
          .filter((definition) => hasOwnershipMarker(definition.description))
          .map((definition) => toAttrs(definition, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const consentStore = storeOf(
        news.consentStore,
        env.project,
        location,
        news.dataset,
      );
      const attributeDefinitionId = yield* toPhysicalSnake(
        id,
        news.attributeDefinitionId,
        output?.attributeDefinitionId,
      );
      const name =
        output?.name ?? resourceName(consentStore, attributeDefinitionId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsConsentStoresAttributeDefinitions(
            {
              parent: consentStore,
              attributeDefinitionId,
              body: {
                category: news.category,
                allowedValues: news.allowedValues,
                description,
                consentDefaultValues: news.consentDefaultValues,
                dataMappingDefaultValue: news.dataMappingDefaultValue,
              },
            },
          ),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsConsentStoresAttributeDefinitionNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(current.description, description);
      const allowedChanged = !sameJson(
        current.allowedValues,
        news.allowedValues,
      );
      const consentDefaultChanged = !sameJson(
        current.consentDefaultValues,
        news.consentDefaultValues,
      );
      const mappingDefaultChanged = !sameText(
        current.dataMappingDefaultValue,
        news.dataMappingDefaultValue,
      );

      if (
        descriptionChanged ||
        allowedChanged ||
        consentDefaultChanged ||
        mappingDefaultChanged
      ) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsConsentStoresAttributeDefinitions(
            {
              name: currentName,
              updateMask: updateMaskOf(
                descriptionChanged ? "description" : undefined,
                allowedChanged ? "allowedValues" : undefined,
                consentDefaultChanged ? "consentDefaultValues" : undefined,
                mappingDefaultChanged ? "dataMappingDefaultValue" : undefined,
              ),
              body: {
                description,
                allowedValues: news.allowedValues,
                consentDefaultValues: news.consentDefaultValues,
                dataMappingDefaultValue: news.dataMappingDefaultValue,
              },
            },
          ),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsConsentStoresAttributeDefinitions(
          {
            name: output.name,
          },
        ),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
