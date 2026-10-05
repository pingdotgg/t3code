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
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAMESPACE_ID_LENGTH = 63;

export type NamespaceProps = {
  /**
   * Namespace id (the `{namespace}` segment of
   * `projects/{project}/locations/{location}/namespaces/{namespace}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and match
   * `[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?`. Immutable — changing it
   * replaces the namespace.
   */
  namespaceId?: string;
  /**
   * Location of the namespace (e.g. `us-central1`). Immutable — changing
   * it replaces the namespace. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Namespace = Resource<
  "GCP.ServiceDirectory.Namespace",
  NamespaceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/namespaces/{namespace}`. */
    name: string;
    /** Namespace id (last path segment). */
    namespaceId: string;
    /** Project id. */
    project: string;
    /** Location id (e.g. `us-central1`). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-assigned UUID4. */
    uid: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Service Directory namespace — a location-scoped container for
 * services.
 *
 * Changing `namespaceId` or `location` replaces the namespace.
 *
 * ### Creating a Namespace
 * **Example:** Generated name
 * ```typescript
 * const services = yield* GCP.ServiceDirectory.Namespace("Services", {});
 * ```
 *
 * **Example:** Explicit id, location, and labels
 * ```typescript
 * const services = yield* GCP.ServiceDirectory.Namespace("Services", {
 *   namespaceId: "app-services",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category ServiceDirectory
 */
export const Namespace = Resource<Namespace>("GCP.ServiceDirectory.Namespace");

export class NamespaceNotResolved extends Data.TaggedError(
  "GCP.ServiceDirectory.NamespaceNotResolved",
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

const resourceName = (project: string, location: string, namespaceId: string) =>
  `projects/${project}/locations/${location}/namespaces/${namespaceId}`;

const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const namespacesAt = parts.lastIndexOf("namespaces");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    namespaceId:
      namespacesAt >= 0 && parts[namespacesAt + 1]
        ? parts[namespacesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, namespaceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (namespaceId !== undefined) return namespaceId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAMESPACE_ID_LENGTH,
      lowercase: true,
      forbiddenPrefixes: ["gcp"],
    });
    const named = /^[a-z]/.test(generated) ? generated : `n${generated}`;
    return named
      .replace(/-+$/g, "")
      .slice(0, MAX_NAMESPACE_ID_LENGTH)
      .replace(/-+$/g, "");
  });

const toAttrs = (
  namespace: servicedirectory.Namespace,
  project: string,
  region: string,
) => {
  const name = namespace.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    namespaceId: parsed.namespaceId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(namespace.labels),
    uid: namespace.uid,
  };
};

const getByName = (name: string) =>
  servicedirectory
    .getProjectsLocationsNamespaces({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listNamespacesAt = (parent: string, project: string, region: string) =>
  Effect.gen(function* () {
    const found: ReturnType<typeof toAttrs>[] = [];
    let pageToken: string | undefined;
    do {
      const response = yield* servicedirectory.listProjectsLocationsNamespaces({
        parent,
        pageSize: 1000,
        pageToken,
      });
      for (const namespace of response.namespaces ?? []) {
        if (
          Object.keys(namespace.labels ?? {}).some((key) =>
            key.startsWith("alchemy-"),
          )
        ) {
          found.push(toAttrs(namespace, project, region));
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

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["name", "namespaceId", "project", "location", "uid"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.namespaceId ?? output?.namespaceId;
      const nextId = news.namespaceId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      if (idChanged || previousLocation !== nextLocation) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const namespaceId = yield* toId(
        id,
        olds?.namespaceId,
        output?.namespaceId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, namespaceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
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
          const pages = yield* Effect.forEach(
            parents.length > 0 ? parents : fallback,
            (parent) => listNamespacesAt(parent, env.project, env.region),
            { concurrency: 4 },
          );
          for (const namespaces of pages) {
            found.push(...namespaces);
          }
          pageToken = response.nextPageToken;
        } while (pageToken !== undefined && pageToken !== "");
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const namespaceId = yield* toId(
        id,
        news.namespaceId,
        output?.namespaceId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, namespaceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* servicedirectory
          .createProjectsLocationsNamespaces({
            parent: locationParent(env.project, location),
            namespaceId,
            body: {
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NamespaceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        current = yield* servicedirectory.patchProjectsLocationsNamespaces({
          name,
          updateMask: "labels",
          body: {
            name,
            labels: desiredLabels,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* servicedirectory
        .deleteProjectsLocationsNamespaces({ name: output.name })
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
