import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  type AttributeValuesMap,
  createOwnership,
  encodeOwnership,
  hasOwnershipMarker,
  listDependencies,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type DependencyEntity = {
  /**
   * Operation resource name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}/operations/{operation}`.
   */
  operationResourceName?: string;
  /**
   * External API resource name
   * `projects/{project}/locations/{location}/externalApis/{externalApi}`.
   */
  externalApiResourceName?: string;
};

export type DependencyProps = {
  /**
   * Dependency id (the `{dependency}` segment of
   * `projects/{project}/locations/{location}/dependencies/{dependency}`).
   * If omitted, a unique id is generated. Immutable — changing it
   * replaces the dependency.
   */
  dependencyId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * dependency.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. Dependencies have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * Consumer entity. Immutable — changing it replaces the dependency.
   */
  consumer: DependencyEntity;
  /**
   * Supplier entity. Immutable — changing it replaces the dependency.
   */
  supplier: DependencyEntity;
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
};

export type Dependency = Resource<
  "GCP.ApiHub.Dependency",
  DependencyProps,
  {
    /** Full resource name. */
    name: string;
    /** Dependency id (last path segment). */
    dependencyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Consumer entity. */
    consumer: DependencyEntity | undefined;
    /** Supplier entity. */
    supplier: DependencyEntity | undefined;
    /** Discovery mode. */
    discoveryMode: string | undefined;
    /** State. */
    state: string | undefined;
    /** Error detail if the system detected a problem. */
    errorDetail: apihub.GoogleCloudApihubV1DependencyErrorDetail | undefined;
    /** User-defined attributes. */
    attributes: AttributeValuesMap | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A directed dependency in API Hub from a consumer operation (or external
 * API) to a supplier operation (or external API).
 *
 * Location, id, consumer, and supplier are immutable. Description updates
 * in place. Dependencies have no labels field — Alchemy stamps ownership
 * into the description.
 *
 * ### Creating a Dependency
 * **Example:** Operation to operation
 * ```typescript
 * const dependency = yield* GCP.ApiHub.Dependency("Calls", {
 *   consumer: { operationResourceName: listPets.name },
 *   supplier: { operationResourceName: getPet.name },
 *   description: "listPets calls getPet",
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Dependency = Resource<Dependency>("GCP.ApiHub.Dependency");

const resourceName = (
  project: string,
  location: string,
  dependencyId: string,
) => `${locationParent(project, location)}/dependencies/${dependencyId}`;

const toEntity = (
  entity: apihub.GoogleCloudApihubV1DependencyEntityReference | undefined,
): DependencyEntity | undefined => {
  if (entity === undefined) return undefined;
  return {
    operationResourceName: entity.operationResourceName,
    externalApiResourceName: entity.externalApiResourceName,
  };
};

const toAttrs = (
  dependency: apihub.GoogleCloudApihubV1Dependency,
  project: string,
  region: string,
): Dependency["Attributes"] => {
  const name = dependency.name ?? "";
  const parsed = parseResourceName(name, "dependencies", region);
  return {
    name,
    dependencyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: parseOwnership(dependency.description).text,
    consumer: toEntity(dependency.consumer),
    supplier: toEntity(dependency.supplier),
    discoveryMode:
      dependency.discoveryMode === undefined
        ? undefined
        : `${dependency.discoveryMode}`,
    state: dependency.state === undefined ? undefined : `${dependency.state}`,
    errorDetail: dependency.errorDetail,
    attributes: dependency.attributes,
    createTime: dependency.createTime,
    updateTime: dependency.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsDependencies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const entityOf = (
  entity: DependencyEntity,
): apihub.GoogleCloudApihubV1DependencyEntityReference => ({
  operationResourceName: entity.operationResourceName,
  externalApiResourceName: entity.externalApiResourceName,
});

export const DependencyProvider = () =>
  Provider.succeed(Dependency, {
    stables: ["name", "dependencyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dependencyId ?? output?.dependencyId,
        nextId: news.dependencyId ?? olds?.dependencyId ?? output?.dependencyId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          !sameJson(
            news.consumer ?? olds?.consumer,
            olds?.consumer ?? output?.consumer,
          ) ||
          !sameJson(
            news.supplier ?? olds?.supplier,
            olds?.supplier ?? output?.supplier,
          ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const dependencyId = yield* toPhysicalId(
        id,
        olds?.dependencyId,
        output?.dependencyId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dependencyId);
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
        const items = yield* listDependencies(
          locationParent(env.project, env.region),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const dependencyId = yield* toPhysicalId(
        id,
        news.dependencyId,
        output?.dependencyId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dependencyId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.description);
      const consumer = entityOf(news.consumer);
      const supplier = entityOf(news.supplier);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsDependencies({
            parent,
            dependencyId,
            body: {
              description,
              consumer,
              supplier,
              attributes: news.attributes,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(current.description, description);

      if (descriptionChanged) {
        current = yield* apihub.patchProjectsLocationsDependencies({
          name: currentName,
          updateMask: updateMaskOf("description"),
          body: {
            name: currentName,
            description,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsDependencies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
