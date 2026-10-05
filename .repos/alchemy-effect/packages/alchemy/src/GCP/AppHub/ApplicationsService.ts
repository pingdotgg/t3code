import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type Attributes,
  type ServiceProperties,
  type ServiceReference,
  encodeOwnership,
  expandApplication,
  fieldMask,
  listNestedOwned,
  listOwnedPages,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  resolveDiscoveredService,
  ResourceNotResolved,
  sameJson,
  sameText,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ApplicationsServiceProps = {
  /**
   * Parent Application. Full name
   * `projects/{project}/locations/{location}/applications/{application}`
   * or the application id (combined with `location`). Immutable —
   * changing it replaces the service.
   */
  application: string;
  /**
   * Region used when `application` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Service id (the `{service}` segment). Must be RFC1035 (63 chars).
   * If omitted, a unique name is generated. Immutable — changing it
   * replaces the service.
   */
  serviceId?: string;
  /**
   * Resource name of the original discovered service, or the underlying
   * resource URI (looked up via `discoveredServices:lookup`). Immutable
   * — changing it replaces the service.
   */
  discoveredService: string;
  /**
   * User-defined display name. Maximum length is 63 characters. Defaults
   * to the service id.
   */
  displayName?: string;
  /**
   * User-defined description. Maximum length is 2048 characters.
   * Services have no labels field, so Alchemy stamps ownership into a
   * `[alchemy …]` prefix and strips it from attributes.
   */
  description?: string;
  /**
   * Consumer-provided attributes (criticality, environment, owners).
   */
  attributes?: Attributes;
};

export type ApplicationsService = Resource<
  "GCP.AppHub.ApplicationsService",
  ApplicationsServiceProps,
  {
    /** Full resource name. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Parent Application resource name. */
    application: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Discovered service resource name. */
    discoveredService: string | undefined;
    /** User-defined display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Consumer-provided attributes. */
    attributes: Attributes | undefined;
    /** Reference to the underlying networking resource. */
    serviceReference: ServiceReference | undefined;
    /** Properties of the underlying compute resource. */
    serviceProperties: ServiceProperties | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Hub service registered onto an Application. A service is a
 * discovered network or API interface (forwarding rule, URL map, Cloud
 * Run service, …) that exposes functionality over the network.
 *
 * Services have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Application, service id, and
 * `discoveredService` are immutable. Display name, description, and
 * attributes update in place.
 *
 * ### Creating a Service
 * **Example:** Register a discovered service
 * ```typescript
 * const service = yield* GCP.AppHub.ApplicationsService("Frontend", {
 *   application: app.name,
 *   discoveredService: discovered.name,
 * });
 * ```
 *
 * **Example:** Lookup from an underlying resource URI
 * ```typescript
 * const service = yield* GCP.AppHub.ApplicationsService("Frontend", {
 *   application: app.name,
 *   discoveredService: forwardingRule.selfLink,
 *   displayName: "frontend",
 *   description: "https load balancer",
 * });
 * ```
 *
 * ### Updating a Service
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Display name and attributes
 * ```typescript
 * const service = yield* GCP.AppHub.ApplicationsService("Frontend", {
 *   application: app.name,
 *   discoveredService: discovered.name,
 *   displayName: "frontend-v2",
 *   attributes: { criticality: { type: "HIGH" } },
 * });
 * ```
 *
 * @resource
 * @category AppHub
 */
export const ApplicationsService = Resource<ApplicationsService>(
  "GCP.AppHub.ApplicationsService",
);

const resourceName = (application: string, serviceId: string) =>
  `${application}/services/${serviceId}`;

const toAttrs = (item: apphub.Service, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "services", region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    serviceId: parsed.id,
    application: parsed.application,
    project: parsed.project || project,
    location: parsed.location,
    discoveredService: item.discoveredService,
    displayName: item.displayName,
    description: ownership.text,
    attributes: item.attributes,
    serviceReference: item.serviceReference,
    serviceProperties: item.serviceProperties,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apphub
        .getProjectsLocationsApplicationsServices({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listNestedOwned(project, region, (application) =>
    listOwnedPages(
      apphub.listProjectsLocationsApplicationsServices.pages({
        parent: application,
        pageSize: 1000,
      }),
      (page) => page.services,
      (item) => item.description,
    ),
  );

export const ApplicationsServiceProvider = () =>
  Provider.succeed(ApplicationsService, {
    stables: [
      "name",
      "serviceId",
      "application",
      "project",
      "location",
      "discoveredService",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDiscovered =
        olds?.discoveredService ?? output?.discoveredService;
      return replaceOnIdentity({
        previousId: olds?.serviceId ?? output?.serviceId,
        nextId: news.serviceId ?? olds?.serviceId ?? output?.serviceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.application ?? output?.application,
        nextParent: news.application,
        extra:
          previousDiscovered !== undefined &&
          news.discoveredService !== undefined &&
          previousDiscovered !== news.discoveredService &&
          !previousDiscovered.endsWith(`/${news.discoveredService}`) &&
          !news.discoveredService.endsWith(`/${previousDiscovered}`),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        olds?.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const application = expandApplication(
        olds?.application ?? output?.application ?? "",
        env.project,
        location,
      );
      const name = output?.name ?? resourceName(application, serviceId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        news.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const application = expandApplication(
        news.application,
        env.project,
        location,
      );
      const name = resourceName(application, serviceId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? serviceId;
      const discoveredService = yield* resolveDiscoveredService(
        locationParent(env.project, location),
        news.discoveredService,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apphub
          .createProjectsLocationsApplicationsServices({
            parent: application,
            serviceId,
            body: {
              discoveredService,
              displayName,
              description,
              attributes: news.attributes,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const mask = fieldMask([
        !sameText(current.description, description) && "description",
        !sameText(current.displayName, displayName) && "displayName",
        news.attributes !== undefined &&
          !sameJson(current.attributes, news.attributes) &&
          "attributes",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* apphub.patchProjectsLocationsApplicationsServices({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName,
              description,
              attributes: news.attributes,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apphub
        .deleteProjectsLocationsApplicationsServices({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
