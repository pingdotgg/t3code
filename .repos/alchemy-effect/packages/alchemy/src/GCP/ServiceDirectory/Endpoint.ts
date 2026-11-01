import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_ENDPOINT_ID_LENGTH = 63;
const DEFAULT_PORT = 0;

export type EndpointProps = {
  /**
   * Parent Service Directory service. Full name
   * `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}`
   * or the service id (combined with `namespace`). Immutable — changing
   * it replaces the endpoint.
   */
  service: string;
  /**
   * Parent namespace. Full name
   * `projects/{project}/locations/{location}/namespaces/{namespace}` or
   * the namespace id (combined with `location`). Used when `service` is
   * a bare id. Immutable — changing it replaces the endpoint.
   */
  namespace?: string;
  /**
   * Location of the endpoint (e.g. `us-central1`). Used when `service`
   * is a bare id. Immutable — changing it replaces the endpoint.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Endpoint id (the `{endpoint}` segment of
   * `.../services/{service}/endpoints/{endpoint}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Must be
   * 1-63 characters and match `[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?`.
   * Immutable — changing it replaces the endpoint.
   */
  endpointId?: string;
  /**
   * IPv4 or IPv6 address. Host:port, IPv6 brackets, and truncated
   * addresses are rejected. Limited to 45 characters.
   */
  address?: string;
  /**
   * Port in `[0, 65535]`.
   * @default 0
   */
  port?: number;
  /**
   * User annotations consumed by service clients. Alchemy ownership
   * (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is merged in
   * automatically. The entire annotations map may contain at most 512
   * characters across all key-value pairs.
   */
  annotations?: Record<string, string>;
  /**
   * Google Compute Engine network of the endpoint, as
   * `projects/{projectNumber}/locations/global/networks/{network}`. The
   * project must be a project *number*. Immutable — changing it
   * replaces the endpoint.
   */
  network?: string;
};

export type Endpoint = Resource<
  "GCP.ServiceDirectory.Endpoint",
  EndpointProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}/endpoints/{endpoint}`. */
    name: string;
    /** Endpoint id (last path segment). */
    endpointId: string;
    /** Parent service resource name. */
    service: string;
    /** Parent namespace resource name. */
    namespace: string;
    /** Project id. */
    project: string;
    /** Location id (e.g. `us-central1`). */
    location: string;
    /** IPv4 or IPv6 address, if set. */
    address: string | undefined;
    /** Port currently on the endpoint. */
    port: number;
    /** User annotations (Alchemy ownership annotations stripped). */
    annotations: Record<string, string>;
    /** VPC network resource name, if set. */
    network: string | undefined;
    /** Server-assigned UUID4. */
    uid: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Service Directory endpoint — an address/port registration on a
 * service. The parent service must already exist.
 *
 * Changing `endpointId`, `service`, `namespace`, `location`, or
 * `network` replaces the endpoint. `address`, `port`, and `annotations`
 * update in place.
 *
 * Endpoints have no labels field. Alchemy stamps ownership into
 * `annotations` so `list` / `pnpm nuke:gcp` can find owned endpoints
 * under alchemy-labeled namespaces.
 *
 * ### Creating an Endpoint
 * **Example:** Address and port on a service
 * ```typescript
 * const ns = yield* GCP.ServiceDirectory.Namespace("Services", {});
 * const api = yield* GCP.ServiceDirectory.Service("Api", {
 *   namespace: ns.name,
 * });
 * const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
 *   service: api.name,
 *   address: "10.0.0.1",
 *   port: 443,
 * });
 * ```
 *
 * **Example:** Explicit id and annotations
 * ```typescript
 * const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
 *   service: api.name,
 *   endpointId: "api-https",
 *   address: "10.0.0.1",
 *   port: 443,
 *   annotations: { protocol: "https" },
 * });
 * ```
 *
 * @resource
 * @category ServiceDirectory
 */
export const Endpoint = Resource<Endpoint>("GCP.ServiceDirectory.Endpoint");

export class EndpointNotResolved extends Data.TaggedError(
  "GCP.ServiceDirectory.EndpointNotResolved",
)<{
  name: string;
}> {}

export class EndpointParentMissing extends Data.TaggedError(
  "GCP.ServiceDirectory.EndpointParentMissing",
)<{
  service: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const normalizeOptional = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const endpointsAt = parts.lastIndexOf("endpoints");
  const servicesAt = parts.lastIndexOf("services");
  const namespacesAt = parts.lastIndexOf("namespaces");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const namespace =
    namespacesAt >= 0 ? parts.slice(0, namespacesAt + 2).join("/") : "";
  const service =
    servicesAt >= 0 ? parts.slice(0, servicesAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    namespace,
    namespaceId:
      namespacesAt >= 0 && parts[namespacesAt + 1]
        ? parts[namespacesAt + 1]!
        : "",
    service,
    serviceId:
      servicesAt >= 0 && parts[servicesAt + 1] ? parts[servicesAt + 1]! : "",
    endpointId:
      endpointsAt >= 0 && parts[endpointsAt + 1]
        ? parts[endpointsAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  service: string,
  namespace: string | undefined,
  location: string | undefined,
  region: string,
) => {
  if (service.includes("/")) {
    const parsed = parseName(
      service.includes("/endpoints/")
        ? service
        : `${service.replace(/\/+$/, "")}/endpoints/_`,
      region,
    );
    return {
      parent: parsed.service,
      location: parsed.location,
      project: parsed.project || project,
      namespace: parsed.namespace,
    };
  }
  const loc = normalizeLocation(location, region);
  if (namespace === undefined || namespace === "") {
    return undefined;
  }
  const namespaceName = namespace.includes("/namespaces/")
    ? namespace.replace(/\/+$/, "")
    : `projects/${project}/locations/${loc}/namespaces/${namespace}`;
  const parsed = parseName(`${namespaceName}/services/_/endpoints/_`, region);
  return {
    parent: `${parsed.namespace}/services/${service}`,
    location: parsed.location,
    project: parsed.project || project,
    namespace: parsed.namespace,
  };
};

const parentKey = (
  service: string | undefined,
  namespace: string | undefined,
  location: string | undefined,
  region: string,
) => {
  if (service === undefined || service === "") return undefined;
  const resolved = resolveParent("_", service, namespace, location, region);
  if (resolved === undefined) return undefined;
  return `${resolved.location}/${lastSegment(resolved.namespace)}/${lastSegment(resolved.parent)}`;
};

const resourceName = (parent: string, endpointId: string) =>
  `${parent}/endpoints/${endpointId}`;

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const hasAlchemyAnnotation = (
  annotations: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(annotations ?? {}).some((key) =>
    key.startsWith(ALCHEMY_LABEL_PREFIX),
  );

const hasAlchemyNamespaceLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const toId = (id: string, endpointId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (endpointId !== undefined) return endpointId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_ENDPOINT_ID_LENGTH,
      lowercase: true,
      forbiddenPrefixes: ["gcp"],
    });
    const named = /^[a-z]/.test(generated) ? generated : `e${generated}`;
    return named
      .replace(/-+$/g, "")
      .slice(0, MAX_ENDPOINT_ID_LENGTH)
      .replace(/-+$/g, "");
  });

const toAttrs = (
  endpoint: servicedirectory.Endpoint,
  project: string,
  region: string,
) => {
  const name = endpoint.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    endpointId: parsed.endpointId,
    service: parsed.service,
    namespace: parsed.namespace,
    project: parsed.project || project,
    location: parsed.location,
    address: normalizeOptional(endpoint.address),
    port: endpoint.port ?? DEFAULT_PORT,
    annotations: userAnnotations(endpoint.annotations),
    network: normalizeOptional(endpoint.network),
    uid: endpoint.uid,
  };
};

const getByName = (name: string) =>
  servicedirectory
    .getProjectsLocationsNamespacesServicesEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const deleteByName = (name: string) =>
  servicedirectory
    .deleteProjectsLocationsNamespacesServicesEndpoints({ name })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        times: 8,
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );

const paginate = <A, E, R>(
  fetch: (
    pageToken: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextPageToken?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    let pageToken: string | undefined;
    do {
      const response = yield* fetch(pageToken);
      found.push(...response.items);
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return found;
  });

const listNamespacesAt = (parent: string) =>
  paginate((pageToken) =>
    servicedirectory
      .listProjectsLocationsNamespaces({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: (response.namespaces ?? []).filter((namespace) =>
            hasAlchemyNamespaceLabels(namespace.labels),
          ),
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as servicedirectory.Namespace[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listServicesAt = (parent: string) =>
  paginate((pageToken) =>
    servicedirectory
      .listProjectsLocationsNamespacesServices({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.services ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as servicedirectory.Service[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listEndpointsAt = (parent: string) =>
  paginate((pageToken) =>
    servicedirectory
      .listProjectsLocationsNamespacesServicesEndpoints({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.endpoints ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as servicedirectory.Endpoint[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listLocations = (project: string) =>
  paginate((pageToken) =>
    servicedirectory
      .listProjectsLocations({
        name: `projects/${project}`,
        pageSize: 100,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name),
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as string[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: [
      "name",
      "endpointId",
      "service",
      "namespace",
      "project",
      "location",
      "uid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.endpointId ?? output?.endpointId;
      const nextId = news.endpointId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent = parentKey(
        olds?.service ?? output?.service,
        olds?.namespace ?? output?.namespace,
        olds?.location ?? output?.location,
        env.region,
      );
      const nextParent = parentKey(
        news.service,
        news.namespace ?? olds?.namespace ?? output?.namespace,
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        previousParent !== nextParent;

      const previousNetwork = normalizeOptional(
        olds?.network ?? output?.network,
      );
      const nextNetwork = normalizeOptional(news.network ?? previousNetwork);
      const networkChanged = previousNetwork !== nextNetwork;

      if (!idChanged && !parentChanged && !networkChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          networkChanged &&
          !idChanged &&
          !parentChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const endpointId = yield* toId(id, olds?.endpointId, output?.endpointId);
      const parent = resolveParent(
        env.project,
        olds?.service ?? output?.service ?? "",
        olds?.namespace ?? output?.namespace,
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        (parent !== undefined
          ? resourceName(parent.parent, endpointId)
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const fallback = [locationParent(env.project, env.region)];
        const locations = yield* listLocations(env.project);
        const parents = locations.length > 0 ? locations : fallback;
        const namespacePages = yield* Effect.forEach(
          parents,
          (parent) => listNamespacesAt(parent),
          { concurrency: 4 },
        );
        const namespaces = namespacePages.flat();
        const servicePages = yield* Effect.forEach(
          namespaces,
          (namespace) =>
            namespace.name
              ? listServicesAt(namespace.name)
              : Effect.succeed([] as servicedirectory.Service[]),
          { concurrency: 4 },
        );
        const services = servicePages.flat();
        const endpointPages = yield* Effect.forEach(
          services,
          (service) =>
            service.name
              ? listEndpointsAt(service.name)
              : Effect.succeed([] as servicedirectory.Endpoint[]),
          { concurrency: 4 },
        );
        return endpointPages
          .flat()
          .filter((endpoint) => hasAlchemyAnnotation(endpoint.annotations))
          .map((endpoint) => toAttrs(endpoint, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const endpointId = yield* toId(id, news.endpointId, output?.endpointId);
      const parent = resolveParent(
        env.project,
        news.service,
        news.namespace ?? output?.namespace,
        news.location ?? output?.location,
        env.region,
      );
      if (parent === undefined) {
        return yield* new EndpointParentMissing({ service: news.service });
      }
      const name = resourceName(parent.parent, endpointId);
      const desiredAnnotations = {
        ...tagRecord(news.annotations),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAddress = news.address;
      const desiredPort = news.port ?? DEFAULT_PORT;
      const desiredNetwork = normalizeOptional(news.network);

      let current = yield* getByName(output?.name ?? name);

      if (
        current !== undefined &&
        normalizeOptional(current.network) !== desiredNetwork
      ) {
        yield* deleteByName(current.name ?? name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* servicedirectory
          .createProjectsLocationsNamespacesServicesEndpoints({
            parent: parent.parent,
            endpointId,
            body: {
              address: desiredAddress,
              port: desiredPort,
              annotations: desiredAnnotations,
              network: desiredNetwork,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EndpointNotResolved({ name });
      }

      const observedAnnotations = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(
        observedAnnotations,
        desiredAnnotations,
      );
      const annotationsChanged = upsert.length > 0 || removed.length > 0;
      const addressChanged = (current.address ?? "") !== (desiredAddress ?? "");
      const portChanged = (current.port ?? DEFAULT_PORT) !== desiredPort;

      if (annotationsChanged || addressChanged || portChanged) {
        const updateMask = [
          annotationsChanged ? "annotations" : undefined,
          addressChanged ? "address" : undefined,
          portChanged ? "port" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current =
          yield* servicedirectory.patchProjectsLocationsNamespacesServicesEndpoints(
            {
              name,
              updateMask,
              body: {
                name,
                annotations: desiredAnnotations,
                address: desiredAddress,
                port: desiredPort,
              },
            },
          );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteByName(output.name);
    }),
  });
