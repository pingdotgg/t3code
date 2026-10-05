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
  listCurations,
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

export type ApplicationIntegrationEndpoint = {
  /**
   * REST URI that triggers an Application Integration workflow.
   * Format:
   * `https://integrations.googleapis.com/v1/projects/{project}/locations/{location}/integrations/{integration}:execute`
   */
  uri: string;
  /** API trigger id of the Application Integration workflow. */
  triggerId: string;
};

export type CurationEndpoint = {
  /** Application Integration endpoint invoked for curation. */
  applicationIntegrationEndpointDetails: ApplicationIntegrationEndpoint;
};

export type CurationProps = {
  /**
   * Curation id (the `{curation}` segment of
   * `projects/{project}/locations/{location}/curations/{curation}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the curation.
   */
  curationId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * curation.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to the curation id.
   */
  displayName?: string;
  /**
   * Human-readable description. Curations have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * Endpoint invoked with API metadata. Immutable — changing it replaces
   * the curation.
   */
  endpoint: CurationEndpoint;
};

export type Curation = Resource<
  "GCP.ApiHub.Curation",
  CurationProps,
  {
    /** Full resource name. */
    name: string;
    /** Curation id (last path segment). */
    curationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Endpoint. */
    endpoint: CurationEndpoint | undefined;
    /** Plugin instances using this curation. */
    pluginInstanceActions: apihub.GoogleCloudApihubV1PluginInstanceActionID[];
    /** Last execution state. */
    lastExecutionState: string | undefined;
    /** Last execution error code. */
    lastExecutionErrorCode: string | undefined;
    /** Last execution error message. */
    lastExecutionErrorMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A curation resource in API Hub. Plugin instances invoke the endpoint
 * with API metadata and receive curated metadata back.
 *
 * Location, id, and endpoint are immutable. Display name and description
 * update in place. Curations have no labels field — Alchemy stamps
 * ownership into the description.
 *
 * ### Creating a Curation
 * **Example:** Application Integration endpoint
 * ```typescript
 * const curation = yield* GCP.ApiHub.Curation("Curate", {
 *   displayName: "curate-apis",
 *   endpoint: {
 *     applicationIntegrationEndpointDetails: {
 *       uri: "https://integrations.googleapis.com/v1/projects/my-project/locations/us-central1/integrations/curate:execute",
 *       triggerId: "api_trigger/curate",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Curation = Resource<Curation>("GCP.ApiHub.Curation");

const resourceName = (project: string, location: string, curationId: string) =>
  `${locationParent(project, location)}/curations/${curationId}`;

const toEndpoint = (
  endpoint: apihub.GoogleCloudApihubV1Endpoint | undefined,
): CurationEndpoint | undefined => {
  const details = endpoint?.applicationIntegrationEndpointDetails;
  if (details?.uri === undefined || details.triggerId === undefined) {
    return undefined;
  }
  return {
    applicationIntegrationEndpointDetails: {
      uri: details.uri,
      triggerId: details.triggerId,
    },
  };
};

const toAttrs = (
  curation: apihub.GoogleCloudApihubV1Curation,
  project: string,
  region: string,
) => {
  const name = curation.name ?? "";
  const parsed = parseResourceName(name, "curations", region);
  return {
    name,
    curationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: curation.displayName,
    description: parseOwnership(curation.description).text,
    endpoint: toEndpoint(curation.endpoint),
    pluginInstanceActions: curation.pluginInstanceActions ?? [],
    lastExecutionState: curation.lastExecutionState,
    lastExecutionErrorCode: curation.lastExecutionErrorCode,
    lastExecutionErrorMessage: curation.lastExecutionErrorMessage,
    createTime: curation.createTime,
    updateTime: curation.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsCurations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CurationProvider = () =>
  Provider.succeed(Curation, {
    stables: ["name", "curationId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.curationId ?? output?.curationId,
        nextId: news.curationId ?? olds?.curationId ?? output?.curationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: !sameJson(
          news.endpoint ?? olds?.endpoint,
          olds?.endpoint ?? output?.endpoint,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const curationId = yield* toPhysicalId(
        id,
        olds?.curationId,
        output?.curationId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, curationId);
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
        const items = yield* listCurations(
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
      const curationId = yield* toPhysicalId(
        id,
        news.curationId,
        output?.curationId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, curationId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? curationId;
      const endpoint: apihub.GoogleCloudApihubV1Endpoint = {
        applicationIntegrationEndpointDetails:
          news.endpoint.applicationIntegrationEndpointDetails,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsCurations({
            parent,
            curationId,
            body: {
              displayName,
              description,
              endpoint,
            },
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

      if (displayChanged || descriptionChanged) {
        current = yield* apihub.patchProjectsLocationsCurations({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            description,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsCurations({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
