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
  type AttributeValues,
  type AttributeValuesMap,
  type Documentation,
  createOwnership,
  encodeOwnership,
  expandParent,
  hasOwnershipMarker,
  listApis,
  listChildResources,
  listVersions,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameJson,
  sameStringList,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type ApisVersionProps = {
  /**
   * Parent API. Full name
   * `projects/{project}/locations/{location}/apis/{api}` or the API id
   * (combined with `location`). Immutable — changing it replaces the
   * version.
   */
  api: string;
  /**
   * Version id (the `{version}` segment of
   * `.../apis/{api}/versions/{version}`). If omitted, a unique id is
   * generated. Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Location used when `api` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to the version id.
   */
  displayName?: string;
  /**
   * Human-readable description. Versions have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * External documentation.
   */
  documentation?: Documentation;
  /**
   * Selected deployment resource name.
   */
  selectedDeployment?: string;
  /**
   * Deployment resource names linked to this version.
   */
  deployments?: string[];
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
  /** System attribute `system-lifecycle`. */
  lifecycle?: AttributeValues;
  /** System attribute `system-compliance`. */
  compliance?: AttributeValues;
  /** System attribute `system-accreditation`. */
  accreditation?: AttributeValues;
};

export type ApisVersion = Resource<
  "GCP.ApiHub.ApisVersion",
  ApisVersionProps,
  {
    /** Full resource name. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent API resource name. */
    api: string;
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
    /** Selected deployment resource name. */
    selectedDeployment: string | undefined;
    /** Linked deployment resource names. */
    deployments: string[];
    /** Spec resource names. */
    specs: string[];
    /** Operation resource names. */
    apiOperations: string[];
    /** Definition resource names. */
    definitions: string[];
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
 * An API version in API Hub. Specs and operations hang off a version.
 *
 * Parent API, location, and id are immutable. Display name, description,
 * documentation, deployments, and attributes update in place. Versions have
 * no labels field — Alchemy stamps ownership into the description.
 *
 * ### Creating a Version
 * **Example:** Version under an API
 * ```typescript
 * const api = yield* GCP.ApiHub.Api("Pets", { displayName: "pets" });
 * const version = yield* GCP.ApiHub.ApisVersion("V1", {
 *   api: api.name,
 *   displayName: "v1",
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const ApisVersion = Resource<ApisVersion>("GCP.ApiHub.ApisVersion");

const resourceName = (api: string, versionId: string) =>
  `${api}/versions/${versionId}`;

const parentApi = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "apis");

const toAttrs = (
  version: apihub.GoogleCloudApihubV1Version,
  project: string,
  region: string,
): ApisVersion["Attributes"] => {
  const name = version.name ?? "";
  const parsed = parseResourceName(name, "versions", region);
  const description = parseOwnership(version.description).text;
  return {
    name,
    versionId: parsed.id,
    api: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: version.displayName,
    description,
    documentation: version.documentation,
    selectedDeployment: version.selectedDeployment,
    deployments: [...(version.deployments ?? [])],
    specs: [...(version.specs ?? [])],
    apiOperations: [...(version.apiOperations ?? [])],
    definitions: [...(version.definitions ?? [])],
    attributes: version.attributes,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsApisVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const bodyOf = (
  news: ApisVersionProps,
  displayName: string,
  description: string,
): apihub.GoogleCloudApihubV1Version => ({
  displayName,
  description,
  documentation: news.documentation,
  selectedDeployment: news.selectedDeployment,
  deployments: news.deployments,
  attributes: news.attributes,
  lifecycle: news.lifecycle,
  compliance: news.compliance,
  accreditation: news.accreditation,
});

export const ApisVersionProvider = () =>
  Provider.succeed(ApisVersion, {
    stables: ["name", "versionId", "api", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.versionId ?? output?.versionId,
        nextId: news.versionId ?? olds?.versionId ?? output?.versionId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.api ?? output?.api,
        nextParent: news.api ?? olds?.api ?? output?.api,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const api = parentApi(
        olds?.api ?? output?.api ?? "",
        env.project,
        location,
      );
      const versionId = yield* toPhysicalId(
        id,
        olds?.versionId,
        output?.versionId,
      );
      const name = output?.name ?? resourceName(api, versionId);
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
        const apis = yield* listApis(
          `projects/${env.project}/locations/${env.region}`,
        );
        const versions = yield* listChildResources(apis, listVersions);
        return versions
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const api = parentApi(news.api, env.project, location);
      const versionId = yield* toPhysicalId(
        id,
        news.versionId,
        output?.versionId,
      );
      const name = output?.name ?? resourceName(api, versionId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? versionId;
      const desired = bodyOf(news, displayName, description);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsApisVersions({
            parent: api,
            versionId,
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
      const docsChanged = !sameJson(current.documentation, news.documentation);
      const selectedChanged = !sameText(
        current.selectedDeployment,
        news.selectedDeployment,
      );
      const deploymentsChanged = !sameStringList(
        current.deployments,
        news.deployments,
      );
      const attributesChanged = !sameJson(current.attributes, news.attributes);
      const lifecycleChanged = !sameJson(current.lifecycle, news.lifecycle);
      const complianceChanged = !sameJson(current.compliance, news.compliance);
      const accreditationChanged = !sameJson(
        current.accreditation,
        news.accreditation,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        docsChanged ||
        selectedChanged ||
        deploymentsChanged ||
        attributesChanged ||
        lifecycleChanged ||
        complianceChanged ||
        accreditationChanged
      ) {
        current = yield* apihub.patchProjectsLocationsApisVersions({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            docsChanged ? "documentation" : undefined,
            selectedChanged ? "selected_deployment" : undefined,
            deploymentsChanged ? "deployments" : undefined,
            attributesChanged ? "attributes" : undefined,
            lifecycleChanged ? "lifecycle" : undefined,
            complianceChanged ? "compliance" : undefined,
            accreditationChanged ? "accreditation" : undefined,
          ),
          body: { name: currentName, ...desired },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsApisVersions({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
