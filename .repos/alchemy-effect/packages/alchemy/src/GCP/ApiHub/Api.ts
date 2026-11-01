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
  createOwnership,
  encodeOwnership,
  hasOwnershipMarker,
  listApis,
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
  type AttributeValues,
  type AttributeValuesMap,
  type Documentation,
} from "./internal.ts";

export type Owner = {
  /** Owner display name. */
  displayName?: string;
  /** Owner email. Required by the API when `owner` is set. */
  email?: string;
};

export type ApiProps = {
  /**
   * API id (the `{api}` segment of
   * `projects/{project}/locations/{location}/apis/{api}`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the API.
   */
  apiId?: string;
  /**
   * Location (`us-central1`, …). Must match the ApiHub instance location.
   * Immutable — changing it replaces the API.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to the API id.
   */
  displayName?: string;
  /**
   * Human-readable description. APIs have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * Unique fingerprint for this API resource.
   */
  fingerprint?: string;
  /**
   * Owner of the API.
   */
  owner?: Owner;
  /**
   * External documentation.
   */
  documentation?: Documentation;
  /**
   * Selected version resource name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   */
  selectedVersion?: string;
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
  /** System attribute `system-target-user`. */
  targetUser?: AttributeValues;
  /** System attribute `system-business-unit`. */
  businessUnit?: AttributeValues;
  /** System attribute `system-maturity-level`. */
  maturityLevel?: AttributeValues;
  /** System attribute `system-team`. */
  team?: AttributeValues;
  /** System attribute `system-api-style`. */
  apiStyle?: AttributeValues;
  /** System attribute `system-api-requirements`. */
  apiRequirements?: AttributeValues;
  /** System attribute `system-api-functional-requirements`. */
  apiFunctionalRequirements?: AttributeValues;
  /** System attribute `system-api-technical-requirements`. */
  apiTechnicalRequirements?: AttributeValues;
};

export type Api = Resource<
  "GCP.ApiHub.Api",
  ApiProps,
  {
    /** Full resource name. */
    name: string;
    /** API id (last path segment). */
    apiId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Fingerprint. */
    fingerprint: string | undefined;
    /** Owner. */
    owner: Owner | undefined;
    /** Documentation. */
    documentation: Documentation | undefined;
    /** Selected version resource name. */
    selectedVersion: string | undefined;
    /** Version resource names. */
    versions: string[];
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
 * An API resource in API Hub. Versions, specs, and operations hang off it.
 *
 * Location and id are immutable. Display name, description, owner,
 * documentation, fingerprint, selected version, and attributes update in
 * place. APIs have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them.
 *
 * ### Creating an API
 * **Example:** Generated id
 * ```typescript
 * const api = yield* GCP.ApiHub.Api("Pets", {
 *   displayName: "pets",
 *   description: "Pet store API",
 * });
 * ```
 *
 * **Example:** Named API with an owner
 * ```typescript
 * const api = yield* GCP.ApiHub.Api("Pets", {
 *   apiId: "pets",
 *   displayName: "pets",
 *   owner: { email: "apihub@example.com", displayName: "platform" },
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Api = Resource<Api>("GCP.ApiHub.Api");

const resourceName = (project: string, location: string, apiId: string) =>
  `${locationParent(project, location)}/apis/${apiId}`;

const toAttrs = (
  api: apihub.GoogleCloudApihubV1Api,
  project: string,
  region: string,
): Api["Attributes"] => {
  const name = api.name ?? "";
  const parsed = parseResourceName(name, "apis", region);
  const description = parseOwnership(api.description).text;
  return {
    name,
    apiId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: api.displayName,
    description,
    fingerprint: api.fingerprint,
    owner:
      api.owner === undefined
        ? undefined
        : {
            displayName: api.owner.displayName,
            email: api.owner.email,
          },
    documentation: api.documentation,
    selectedVersion: api.selectedVersion,
    versions: [...(api.versions ?? [])],
    attributes: api.attributes,
    createTime: api.createTime,
    updateTime: api.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsApis({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const bodyOf = (
  news: ApiProps,
  displayName: string,
  description: string,
): apihub.GoogleCloudApihubV1Api => ({
  displayName,
  description,
  fingerprint: news.fingerprint,
  owner: news.owner,
  documentation: news.documentation,
  selectedVersion: news.selectedVersion,
  attributes: news.attributes,
  targetUser: news.targetUser,
  businessUnit: news.businessUnit,
  maturityLevel: news.maturityLevel,
  team: news.team,
  apiStyle: news.apiStyle,
  apiRequirements: news.apiRequirements,
  apiFunctionalRequirements: news.apiFunctionalRequirements,
  apiTechnicalRequirements: news.apiTechnicalRequirements,
});

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["name", "apiId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.apiId ?? output?.apiId,
        nextId: news.apiId ?? olds?.apiId ?? output?.apiId,
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
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const apiId = yield* toPhysicalId(id, olds?.apiId, output?.apiId);
      const name = output?.name ?? resourceName(env.project, location, apiId);
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
        const items = yield* listApis(locationParent(env.project, env.region));
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
      const apiId = yield* toPhysicalId(id, news.apiId, output?.apiId);
      const name = output?.name ?? resourceName(env.project, location, apiId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? apiId;
      const desired = bodyOf(news, displayName, description);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsApis({
            parent,
            apiId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const fingerprintChanged = !sameText(
        current.fingerprint,
        news.fingerprint,
      );
      const ownerChanged = !sameJson(current.owner, news.owner);
      const docsChanged = !sameJson(current.documentation, news.documentation);
      const selectedChanged = !sameText(
        current.selectedVersion,
        news.selectedVersion,
      );
      const attributesChanged = !sameJson(current.attributes, news.attributes);
      const targetChanged = !sameJson(current.targetUser, news.targetUser);
      const unitChanged = !sameJson(current.businessUnit, news.businessUnit);
      const maturityChanged = !sameJson(
        current.maturityLevel,
        news.maturityLevel,
      );
      const teamChanged = !sameJson(current.team, news.team);
      const styleChanged = !sameJson(current.apiStyle, news.apiStyle);
      const requirementsChanged = !sameJson(
        current.apiRequirements,
        news.apiRequirements,
      );
      const functionalChanged = !sameJson(
        current.apiFunctionalRequirements,
        news.apiFunctionalRequirements,
      );
      const technicalChanged = !sameJson(
        current.apiTechnicalRequirements,
        news.apiTechnicalRequirements,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        fingerprintChanged ||
        ownerChanged ||
        docsChanged ||
        selectedChanged ||
        attributesChanged ||
        targetChanged ||
        unitChanged ||
        maturityChanged ||
        teamChanged ||
        styleChanged ||
        requirementsChanged ||
        functionalChanged ||
        technicalChanged
      ) {
        current = yield* apihub.patchProjectsLocationsApis({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            fingerprintChanged ? "fingerprint" : undefined,
            ownerChanged ? "owner" : undefined,
            docsChanged ? "documentation" : undefined,
            selectedChanged ? "selected_version" : undefined,
            attributesChanged ? "attributes" : undefined,
            targetChanged ? "target_user" : undefined,
            unitChanged ? "business_unit" : undefined,
            maturityChanged ? "maturity_level" : undefined,
            teamChanged ? "team" : undefined,
            styleChanged ? "api_style" : undefined,
            requirementsChanged ? "api_requirements" : undefined,
            functionalChanged ? "api_functional_requirements" : undefined,
            technicalChanged ? "api_technical_requirements" : undefined,
          ),
          body: { name: currentName, ...desired },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsApis({ name: output.name, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
