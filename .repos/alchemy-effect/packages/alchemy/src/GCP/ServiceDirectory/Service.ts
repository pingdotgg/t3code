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
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_SERVICE_ID_LENGTH = 63;

export type ServiceProps = {
  /**
   * Parent namespace. Full name
   * `projects/{project}/locations/{location}/namespaces/{namespace}` or
   * the namespace id (combined with `location`). Immutable — changing it
   * replaces the service.
   */
  namespace: string;
  /**
   * Location of the service (e.g. `us-central1`). Used when `namespace`
   * is a bare id. Immutable — changing it replaces the service.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Service id (the `{service}` segment of
   * `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and match
   * `[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?`. Immutable — changing it
   * replaces the service.
   */
  serviceId?: string;
  /**
   * User annotations consumed by service clients. Alchemy ownership
   * keys (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) are merged
   * in automatically — Service Directory services have no labels field.
   * The entire map may contain at most 2000 characters.
   */
  annotations?: Record<string, string>;
};

export type Service = Resource<
  "GCP.ServiceDirectory.Service",
  ServiceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}`. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Parent namespace resource name. */
    namespace: string;
    /** Namespace id (last path segment of the parent). */
    namespaceId: string;
    /** Project id. */
    project: string;
    /** Location id (e.g. `us-central1`). */
    location: string;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Server-assigned UUID4. */
    uid: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Service Directory service — a named registration that holds
 * endpoints and client-facing annotations.
 *
 * Changing `serviceId`, `namespace`, or `location` replaces the service.
 * Annotations update in place. Services have no labels field; Alchemy
 * stamps ownership into annotations so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * ### Creating a Service
 * **Example:** Generated name in a namespace
 * ```typescript
 * const ns = yield* GCP.ServiceDirectory.Namespace("Services", {});
 * const api = yield* GCP.ServiceDirectory.Service("Api", {
 *   namespace: ns.name,
 * });
 * ```
 *
 * **Example:** Explicit id and annotations
 * ```typescript
 * const api = yield* GCP.ServiceDirectory.Service("Api", {
 *   namespace: ns.name,
 *   serviceId: "checkout",
 *   annotations: { protocol: "http" },
 * });
 * ```
 *
 * ### Resolving Endpoints
 * **Example:** Resolve the service at runtime
 * ```typescript
 * const resolve = yield* GCP.ServiceDirectory.Resolve(api);
 * const { service } = yield* resolve();
 * ```
 *
 * @resource
 * @category ServiceDirectory
 */
export const Service = Resource<Service>("GCP.ServiceDirectory.Service");

export class ServiceNotResolved extends Data.TaggedError(
  "GCP.ServiceDirectory.ServiceNotResolved",
)<{
  name: string;
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

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const servicesAt = parts.lastIndexOf("services");
  const namespacesAt = parts.lastIndexOf("namespaces");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const namespace =
    namespacesAt >= 0 ? parts.slice(0, namespacesAt + 2).join("/") : "";
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
    serviceId:
      servicesAt >= 0 && parts[servicesAt + 1]
        ? parts[servicesAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  namespace: string,
  location: string | undefined,
  region: string,
) => {
  if (namespace.includes("/")) {
    const parsed = parseName(
      namespace.includes("/services/") ? namespace : `${namespace}/services/_`,
      region,
    );
    return {
      parent: parsed.namespace,
      location: parsed.location,
      project: parsed.project || project,
      namespaceId: parsed.namespaceId,
    };
  }
  const loc = normalizeLocation(location, region);
  return {
    parent: `projects/${project}/locations/${loc}/namespaces/${namespace}`,
    location: loc,
    project,
    namespaceId: namespace,
  };
};

const resourceName = (parent: string, serviceId: string) =>
  `${parent}/services/${serviceId}`;

const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const toId = (id: string, serviceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (serviceId !== undefined) return serviceId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_SERVICE_ID_LENGTH,
      lowercase: true,
    });
    const named = /^[a-z]/.test(generated) ? generated : `s${generated}`;
    return named
      .replace(/-+$/g, "")
      .slice(0, MAX_SERVICE_ID_LENGTH)
      .replace(/-+$/g, "");
  });

const toAttrs = (
  service: servicedirectory.Service,
  project: string,
  region: string,
) => {
  const name = service.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    serviceId: parsed.serviceId,
    namespace: parsed.namespace,
    namespaceId: parsed.namespaceId,
    project: parsed.project || project,
    location: parsed.location,
    annotations: userAnnotations(service.annotations),
    uid: service.uid,
  };
};

const getByName = (name: string) =>
  servicedirectory
    .getProjectsLocationsNamespacesServices({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const hasAlchemyAnnotation = (
  annotations: Record<string, string | undefined> | null | undefined,
) => Object.keys(annotations ?? {}).some((key) => key.startsWith("alchemy-"));

const listServicesAt = (parent: string, project: string, region: string) =>
  Effect.gen(function* () {
    const found: ReturnType<typeof toAttrs>[] = [];
    let pageToken: string | undefined;
    do {
      const response =
        yield* servicedirectory.listProjectsLocationsNamespacesServices({
          parent,
          pageSize: 1000,
          pageToken,
        });
      for (const service of response.services ?? []) {
        if (hasAlchemyAnnotation(service.annotations)) {
          found.push(toAttrs(service, project, region));
        }
      }
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as ReturnType<typeof toAttrs>[]),
    ),
  );

const listNamespaceNamesAt = (parent: string) =>
  Effect.gen(function* () {
    const found: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = yield* servicedirectory.listProjectsLocationsNamespaces({
        parent,
        pageSize: 1000,
        pageToken,
      });
      for (const namespace of response.namespaces ?? []) {
        if (namespace.name) found.push(namespace.name);
      }
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return found;
  }).pipe(Effect.catchTag("NotFound", () => Effect.succeed([] as string[])));

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: [
      "name",
      "serviceId",
      "namespace",
      "namespaceId",
      "project",
      "location",
      "uid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.serviceId ?? output?.serviceId;
      const nextId = news.serviceId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent = output?.namespace ?? olds?.namespace;
      const previousParentId = previousParent
        ? lastSegment(previousParent)
        : undefined;
      const nextParentId = lastSegment(news.namespace);
      const parentChanged =
        previousParentId !== undefined && previousParentId !== nextParentId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = news.namespace.includes("/")
        ? parseName(
            news.namespace.includes("/services/")
              ? news.namespace
              : `${news.namespace}/services/_`,
            env.region,
          ).location
        : normalizeLocation(news.location ?? output?.location, env.region);

      if (idChanged || parentChanged || previousLocation !== nextLocation) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toId(id, olds?.serviceId, output?.serviceId);
      const namespaceRef = olds?.namespace ?? output?.namespace;
      const name =
        output?.name ??
        (namespaceRef
          ? resourceName(
              resolveParent(
                env.project,
                namespaceRef,
                olds?.location ?? output?.location,
                env.region,
              ).parent,
              serviceId,
            )
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
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        do {
          const response = yield* servicedirectory
            .listProjectsLocations({
              name: `projects/${env.project}`,
              pageSize: 100,
              pageToken,
            })
            .pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed({
                  locations: [
                    {
                      name: fallback[0],
                      locationId: env.region,
                    } satisfies servicedirectory.Location,
                  ],
                  nextPageToken: undefined as string | undefined,
                }),
              ),
            );
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const namespacePages = yield* Effect.forEach(
            parents.length > 0 ? parents : fallback,
            (parent) => listNamespaceNamesAt(parent),
            { concurrency: 4 },
          );
          const namespaceNames = namespacePages.flat();
          const servicePages = yield* Effect.forEach(
            namespaceNames,
            (parent) => listServicesAt(parent, env.project, env.region),
            { concurrency: 4 },
          );
          for (const services of servicePages) {
            found.push(...services);
          }
          pageToken = response.nextPageToken;
        } while (pageToken !== undefined && pageToken !== "");
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = resolveParent(
        env.project,
        news.namespace,
        news.location ?? output?.location,
        env.region,
      );
      const serviceId = yield* toId(id, news.serviceId, output?.serviceId);
      const name = resourceName(parent.parent, serviceId);
      const desiredAnnotations = {
        ...tagRecord(news.annotations),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* servicedirectory
          .createProjectsLocationsNamespacesServices({
            parent: parent.parent,
            serviceId,
            body: {
              annotations: desiredAnnotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ServiceNotResolved({ name });
      }

      const observedAnnotations = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(
        observedAnnotations,
        desiredAnnotations,
      );
      if (upsert.length > 0 || removed.length > 0) {
        current =
          yield* servicedirectory.patchProjectsLocationsNamespacesServices({
            name,
            updateMask: "annotations",
            body: {
              name,
              annotations: desiredAnnotations,
            },
          });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* servicedirectory
        .deleteProjectsLocationsNamespacesServices({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
