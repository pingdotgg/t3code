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
  decodeDataId,
  encodeDataId,
  expandParent,
  hasOwnedDataId,
  listAlchemyConsentStores,
  normalizeLocation,
  parseResourceName,
  retryTransient,
  sameJson,
  sameText,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type DatasetsConsentStoresUserDataMappingProps = {
  /**
   * Parent consent store. Full name
   * `.../consentStores/{consentStore}` or the store id (combined with
   * `dataset` and `location`). Immutable — changing it replaces the
   * mapping.
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
   * User UUID supplied by the client.
   */
  userId: string;
  /**
   * Unique identifier for the mapped resource. User data mappings have
   * no labels field, so Alchemy prefixes `dataId` with `alc-{id}-` and
   * strips it from attributes.
   */
  dataId: string;
  /**
   * Single-valued resource attributes.
   */
  resourceAttributes?: healthcare.Attribute[];
};

export type DatasetsConsentStoresUserDataMapping = Resource<
  "GCP.Healthcare.DatasetsConsentStoresUserDataMapping",
  DatasetsConsentStoresUserDataMappingProps,
  {
    /** Full resource name `.../userDataMappings/{userDataMapping}`. */
    name: string;
    /** Server-assigned mapping id. */
    userDataMappingId: string;
    /** Parent consent store resource name. */
    consentStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User id. */
    userId: string | undefined;
    /** Mapped resource id with the Alchemy prefix stripped. */
    dataId: string | undefined;
    /** Resource attributes. */
    resourceAttributes: healthcare.Attribute[] | undefined;
    /** Whether the mapping is archived. */
    archived: boolean;
    /** RFC3339 archive time. */
    archiveTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * Maps a resource to a user and consent attributes.
 *
 * Mapping ids are server-assigned. `userId`, `dataId`, and resource
 * attributes update in place. Ownership is stamped into `dataId`.
 *
 * ### Creating a User Data Mapping
 * **Example:** Map a FHIR resource to a user
 * ```typescript
 * const mapping = yield* GCP.Healthcare.DatasetsConsentStoresUserDataMapping(
 *   "Chart",
 *   {
 *     consentStore: store.name,
 *     userId: "user-123",
 *     dataId: "Patient/abc",
 *   },
 * );
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsConsentStoresUserDataMapping =
  Resource<DatasetsConsentStoresUserDataMapping>(
    "GCP.Healthcare.DatasetsConsentStoresUserDataMapping",
  );

export class DatasetsConsentStoresUserDataMappingNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsConsentStoresUserDataMappingNotResolved",
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

const toAttrs = (
  mapping: healthcare.UserDataMapping,
  project: string,
  region: string,
) => {
  const name = mapping.name ?? "";
  const parsed = parseResourceName(name, "userDataMappings", region);
  return {
    name,
    userDataMappingId: parsed.id,
    consentStore: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    userId: mapping.userId,
    dataId: decodeDataId(mapping.dataId),
    resourceAttributes: mapping.resourceAttributes,
    archived: mapping.archived === true,
    archiveTime: mapping.archiveTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsConsentStoresUserDataMappings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsConsentStoresUserDataMappingProvider = () =>
  Provider.succeed(DatasetsConsentStoresUserDataMapping, {
    stables: [
      "name",
      "userDataMappingId",
      "consentStore",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.consentStore ?? output?.consentStore;
      const nextParent = storeOf(
        news.consentStore,
        env.project,
        normalizeLocation(news.location ?? output?.location, env.region),
        news.dataset,
      );
      if (previousParent !== undefined && previousParent !== nextParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return hasOwnedDataId(existing.dataId) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listAlchemyConsentStores(env.project, env.region);
        const mappings = yield* Effect.forEach(
          stores,
          (store) =>
            collectPages(
              healthcare.listProjectsLocationsDatasetsConsentStoresUserDataMappings.pages(
                {
                  parent: store.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.userDataMappings,
            ),
          { concurrency: 4 },
        );
        return mappings
          .flat()
          .filter((mapping) => hasOwnedDataId(mapping.dataId))
          .map((mapping) => toAttrs(mapping, env.project, env.region));
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
      const ownership = yield* createInternalLabels(id);
      const dataId = encodeDataId(ownership, news.dataId);

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        current = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsConsentStoresUserDataMappings(
            {
              parent: consentStore,
              body: {
                userId: news.userId,
                dataId,
                resourceAttributes: news.resourceAttributes,
              },
            },
          ),
        );
      }

      if (current === undefined) {
        return yield* new DatasetsConsentStoresUserDataMappingNotResolved({
          name: consentStore,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const userChanged = !sameText(current.userId, news.userId);
      const dataChanged = !sameText(current.dataId, dataId);
      const attrsChanged = !sameJson(
        current.resourceAttributes,
        news.resourceAttributes,
      );

      if (userChanged || dataChanged || attrsChanged) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsConsentStoresUserDataMappings(
            {
              name: currentName,
              updateMask: updateMaskOf(
                userChanged ? "userId" : undefined,
                dataChanged ? "dataId" : undefined,
                attrsChanged ? "resourceAttributes" : undefined,
              ),
              body: {
                userId: news.userId,
                dataId,
                resourceAttributes: news.resourceAttributes,
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
        healthcare.deleteProjectsLocationsDatasetsConsentStoresUserDataMappings(
          {
            name: output.name,
          },
        ),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
