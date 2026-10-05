import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  encodeOwnership,
  hasOwnershipMarker,
  locationParent,
  MAX_LONG_ID_LENGTH,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameStringList,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

type AttributeValuesMap = apihub.GoogleCloudApihubV1AttributeValuesMap;
type Documentation = apihub.GoogleCloudApihubV1Documentation;

export type ExternalApiProps = {
  /**
   * External API id (the `{externalApi}` segment of
   * `projects/{project}/locations/{location}/externalApis/{externalApi}`).
   * If omitted, a unique id is generated. Immutable — changing it replaces
   * the External API.
   */
  externalApiId?: string;
  /**
   * Location of the API Hub instance (`us-central1`, …). Immutable —
   * changing it replaces the External API.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Max 63 characters.
   */
  displayName?: string;
  /**
   * Human-readable description. External APIs have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * Documentation URI.
   */
  documentation?: Documentation;
  /**
   * Endpoints on which this API is accessible.
   */
  endpoints?: string[];
  /**
   * Paths served by this API.
   */
  paths?: string[];
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
};

export type ExternalApi = Resource<
  "GCP.ApiHub.ExternalApi",
  ExternalApiProps,
  {
    /** Full resource name. */
    name: string;
    /** External API id (last path segment). */
    externalApiId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Documentation. */
    documentation: Documentation | undefined;
    /** Endpoints. */
    endpoints: string[];
    /** Paths. */
    paths: string[];
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
 * An API Hub External API — a third-party API modeled so it can be
 * referenced from dependencies.
 *
 * External APIs have no labels, so Alchemy stamps ownership into the
 * description for `list` / nuke. Location and id are identity — changing
 * them replaces the resource. Display name, description, documentation,
 * endpoints, and paths update in place.
 *
 * ### Creating an External API
 * **Example:** Generated id
 * ```typescript
 * const stripe = yield* GCP.ApiHub.ExternalApi("Stripe", {
 *   displayName: "Stripe",
 *   endpoints: ["https://api.stripe.com"],
 *   paths: ["/v1/charges"],
 * });
 * ```
 *
 * **Example:** Named External API
 * ```typescript
 * const stripe = yield* GCP.ApiHub.ExternalApi("Stripe", {
 *   externalApiId: "stripe-prod",
 *   displayName: "Stripe",
 *   description: "payments",
 *   endpoints: ["https://api.stripe.com"],
 * });
 * ```
 *
 * ### Updating an External API
 * **Example:** Change description and paths
 * ```typescript
 * const stripe = yield* GCP.ApiHub.ExternalApi("Stripe", {
 *   displayName: "Stripe",
 *   description: "payments (updated)",
 *   paths: ["/v1/charges", "/v1/customers"],
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const ExternalApi = Resource<ExternalApi>("GCP.ApiHub.ExternalApi");

const resourceName = (
  project: string,
  location: string,
  externalApiId: string,
) => `${locationParent(project, location)}/externalApis/${externalApiId}`;

const toAttrs = (
  api: apihub.GoogleCloudApihubV1ExternalApi,
  project: string,
  region: string,
) => {
  const name = api.name ?? "";
  const parsed = parseName(name, "externalApis", region);
  const { text } = parseOwnership(api.description);
  return {
    name,
    externalApiId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: api.displayName,
    description: text,
    documentation: api.documentation,
    endpoints: [...(api.endpoints ?? [])],
    paths: [...(api.paths ?? [])],
    attributes: api.attributes,
    createTime: api.createTime,
    updateTime: api.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsExternalApis({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  apihub.listProjectsLocationsExternalApis
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.externalApis ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.map((item) => toAttrs(item, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ExternalApiProvider = () =>
  Provider.succeed(ExternalApi, {
    stables: ["name", "externalApiId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.externalApiId ?? output?.externalApiId,
        nextId:
          news.externalApiId ?? olds?.externalApiId ?? output?.externalApiId,
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
      const externalApiId = yield* toPhysicalId(
        id,
        olds?.externalApiId,
        output?.externalApiId,
        MAX_LONG_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, externalApiId);
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
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const externalApiId = yield* toPhysicalId(
        id,
        news.externalApiId,
        output?.externalApiId,
        MAX_LONG_ID_LENGTH,
      );
      const name = resourceName(env.project, location, externalApiId);
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = (news.displayName ?? externalApiId).slice(0, 63);
      const parent = locationParent(env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsExternalApis({
            parent,
            externalApiId,
            body: {
              displayName,
              description,
              documentation: news.documentation,
              endpoints: news.endpoints,
              paths: news.paths,
              attributes: news.attributes,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* getByName(name));
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observed = parseOwnership(current.description).text;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(observed, news.description);
      const documentationChanged = !sameJson(
        current.documentation,
        news.documentation,
      );
      const endpointsChanged = !sameStringList(
        current.endpoints,
        news.endpoints,
      );
      const pathsChanged = !sameStringList(current.paths, news.paths);

      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        documentationChanged ? "documentation" : undefined,
        endpointsChanged ? "endpoints" : undefined,
        pathsChanged ? "paths" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* apihub.patchProjectsLocationsExternalApis({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            displayName,
            description,
            documentation: news.documentation,
            endpoints: news.endpoints,
            paths: news.paths,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsExternalApis({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
