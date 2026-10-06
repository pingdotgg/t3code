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
  DEFAULT_DEPLOYMENT_TYPE,
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

type AttributeValues = apihub.GoogleCloudApihubV1AttributeValues;
type AttributeValuesMap = apihub.GoogleCloudApihubV1AttributeValuesMap;
type Documentation = apihub.GoogleCloudApihubV1Documentation;

export type DeploymentProps = {
  /**
   * Deployment id (the `{deployment}` segment of
   * `projects/{project}/locations/{location}/deployments/{deployment}`).
   * If omitted, a unique id is generated. Immutable — changing it replaces
   * the deployment.
   */
  deploymentId?: string;
  /**
   * Location of the API Hub instance (`us-central1`, …). Immutable —
   * changing it replaces the deployment. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * Human-readable description. API Hub deployments have no labels
   * field, so Alchemy stamps ownership into a `[alchemy …]` prefix and
   * strips it from attributes.
   */
  description?: string;
  /**
   * Documentation URI for the deployment.
   */
  documentation?: Documentation;
  /**
   * Deployment type (`system-deployment-type` enum). Defaults to the
   * `others` allowed value.
   */
  deploymentType?: AttributeValues;
  /**
   * Resource URI that identifies the deployment in its gateway.
   */
  resourceUri: string;
  /**
   * Endpoints at which this deployment listens (URIs, hostnames, or IPs).
   */
  endpoints: string[];
  /**
   * SLO attribute values.
   */
  slo?: AttributeValues;
  /**
   * Environment attribute values.
   */
  environment?: AttributeValues;
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
  /**
   * Source project or org identifier.
   */
  sourceProject?: string;
  /**
   * Source environment (`prod`, `dev`, `staging`, …).
   */
  sourceEnvironment?: string;
  /**
   * Management URL attribute values.
   */
  managementUrl?: AttributeValues;
  /**
   * Source URI attribute values.
   */
  sourceUri?: AttributeValues;
};

export type Deployment = Resource<
  "GCP.ApiHub.Deployment",
  DeploymentProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment id (last path segment). */
    deploymentId: string;
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
    /** Deployment type. */
    deploymentType: AttributeValues | undefined;
    /** Gateway resource URI. */
    resourceUri: string | undefined;
    /** Listening endpoints. */
    endpoints: string[];
    /** Linked API versions. */
    apiVersions: string[];
    /** SLO attribute. */
    slo: AttributeValues | undefined;
    /** Environment attribute. */
    environment: AttributeValues | undefined;
    /** User-defined attributes. */
    attributes: AttributeValuesMap | undefined;
    /** Source metadata. */
    sourceMetadata: apihub.GoogleCloudApihubV1SourceMetadataList | undefined;
    /** Source project. */
    sourceProject: string | undefined;
    /** Source environment. */
    sourceEnvironment: string | undefined;
    /** Management URL. */
    managementUrl: AttributeValues | undefined;
    /** Source URI. */
    sourceUri: AttributeValues | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Hub deployment — a gateway, proxy, or other runtime that hosts
 * APIs. Deployments are root-level entities and exist independently of
 * any API.
 *
 * API Hub deployments have no labels, so Alchemy stamps ownership into
 * the description for `list` / nuke. Location and deployment id are
 * identity — changing them replaces the deployment. Display name,
 * description, type, URI, endpoints, and related attributes update in
 * place.
 *
 * ### Creating a Deployment
 * **Example:** Generated id
 * ```typescript
 * const deployment = yield* GCP.ApiHub.Deployment("Orders", {
 *   resourceUri: "organizations/cymbal/environments/staging/apis/orders",
 *   endpoints: ["https://orders.example.com"],
 * });
 * ```
 *
 * **Example:** Named deployment with type and description
 * ```typescript
 * const deployment = yield* GCP.ApiHub.Deployment("Orders", {
 *   deploymentId: "orders-staging",
 *   displayName: "orders staging",
 *   description: "checkout proxy",
 *   resourceUri: "organizations/cymbal/environments/staging/apis/orders",
 *   endpoints: ["https://orders.example.com"],
 *   deploymentType: { enumValues: { values: [{ id: "apigee" }] } },
 * });
 * ```
 *
 * ### Updating a Deployment
 * **Example:** Change description and endpoints
 * ```typescript
 * const deployment = yield* GCP.ApiHub.Deployment("Orders", {
 *   resourceUri: "organizations/cymbal/environments/staging/apis/orders",
 *   endpoints: ["https://orders.example.com", "https://orders-alt.example.com"],
 *   description: "checkout proxy (updated)",
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Deployment = Resource<Deployment>("GCP.ApiHub.Deployment");

const resourceName = (
  project: string,
  location: string,
  deploymentId: string,
) => `${locationParent(project, location)}/deployments/${deploymentId}`;

const toAttrs = (
  deployment: apihub.GoogleCloudApihubV1Deployment,
  project: string,
  region: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseName(name, "deployments", region);
  const { text } = parseOwnership(deployment.description);
  return {
    name,
    deploymentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: deployment.displayName,
    description: text,
    documentation: deployment.documentation,
    deploymentType: deployment.deploymentType,
    resourceUri: deployment.resourceUri,
    endpoints: [...(deployment.endpoints ?? [])],
    apiVersions: [...(deployment.apiVersions ?? [])],
    slo: deployment.slo,
    environment: deployment.environment,
    attributes: deployment.attributes,
    sourceMetadata: deployment.sourceMetadata,
    sourceProject: deployment.sourceProject,
    sourceEnvironment: deployment.sourceEnvironment,
    managementUrl: deployment.managementUrl,
    sourceUri: deployment.sourceUri,
    createTime: deployment.createTime,
    updateTime: deployment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsDeployments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  apihub.listProjectsLocationsDeployments
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.deployments ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.map((item) => toAttrs(item, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toBody = (
  news: DeploymentProps,
  description: string,
  displayName: string,
): apihub.GoogleCloudApihubV1Deployment => ({
  displayName,
  description,
  documentation: news.documentation,
  deploymentType: news.deploymentType ?? DEFAULT_DEPLOYMENT_TYPE,
  resourceUri: news.resourceUri,
  endpoints: news.endpoints,
  slo: news.slo,
  environment: news.environment,
  attributes: news.attributes,
  sourceProject: news.sourceProject,
  sourceEnvironment: news.sourceEnvironment,
  managementUrl: news.managementUrl,
  sourceUri: news.sourceUri,
});

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: ["name", "deploymentId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.deploymentId ?? output?.deploymentId,
        nextId: news.deploymentId ?? olds?.deploymentId ?? output?.deploymentId,
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
      const deploymentId = yield* toPhysicalId(
        id,
        olds?.deploymentId,
        output?.deploymentId,
        MAX_LONG_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, deploymentId);
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
      const deploymentId = yield* toPhysicalId(
        id,
        news.deploymentId,
        output?.deploymentId,
        MAX_LONG_ID_LENGTH,
      );
      const name = resourceName(env.project, location, deploymentId);
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? deploymentId;
      const parent = locationParent(env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsDeployments({
            parent,
            deploymentId,
            body: toBody(news, description, displayName),
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
      const typeChanged = !sameJson(
        current.deploymentType,
        news.deploymentType ?? DEFAULT_DEPLOYMENT_TYPE,
      );
      const uriChanged = !sameText(current.resourceUri, news.resourceUri);
      const endpointsChanged = !sameStringList(
        current.endpoints,
        news.endpoints,
      );
      const sloChanged = !sameJson(current.slo, news.slo);
      const environmentChanged = !sameJson(
        current.environment,
        news.environment,
      );
      const attributesChanged = !sameJson(current.attributes, news.attributes);
      const sourceProjectChanged = !sameText(
        current.sourceProject,
        news.sourceProject,
      );
      const sourceEnvironmentChanged = !sameText(
        current.sourceEnvironment,
        news.sourceEnvironment,
      );
      const managementUrlChanged = !sameJson(
        current.managementUrl,
        news.managementUrl,
      );
      const sourceUriChanged = !sameJson(current.sourceUri, news.sourceUri);

      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        documentationChanged ? "documentation" : undefined,
        typeChanged ? "deployment_type" : undefined,
        uriChanged ? "resource_uri" : undefined,
        endpointsChanged ? "endpoints" : undefined,
        sloChanged ? "slo" : undefined,
        environmentChanged ? "environment" : undefined,
        attributesChanged ? "attributes" : undefined,
        sourceProjectChanged ? "source_project" : undefined,
        sourceEnvironmentChanged ? "source_environment" : undefined,
        managementUrlChanged ? "management_url" : undefined,
        sourceUriChanged ? "source_uri" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* apihub.patchProjectsLocationsDeployments({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            ...toBody(news, description, displayName),
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsDeployments({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
