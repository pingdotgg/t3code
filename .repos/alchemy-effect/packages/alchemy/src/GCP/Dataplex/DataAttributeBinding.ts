import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  collectPages,
  fingerprint,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DataAttributeBindingPath =
  dataplex.GoogleCloudDataplexV1DataAttributeBindingPath;

export type DataAttributeBindingProps = {
  /**
   * DataAttributeBinding id. If omitted, a unique name is generated.
   * Must contain only lowercase letters, numbers and hyphens, start with
   * a letter, end with a letter or number, and be 1-63 characters.
   * Immutable — changing it replaces the binding.
   */
  dataAttributeBindingId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * binding.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Immutable Dataplex entity this binding attaches to. Changing it
   * replaces the binding.
   */
  resource?: string;
  /**
   * DataAttribute resource names to associate with the resource.
   */
  attributes?: string[];
  /**
   * Path-level attribute bindings (columns, partitions).
   */
  paths?: DataAttributeBindingPath[];
};

export type DataAttributeBinding = Resource<
  "GCP.Dataplex.DataAttributeBinding",
  DataAttributeBindingProps,
  {
    /** Full resource name. */
    name: string;
    /** Binding id (last path segment). */
    dataAttributeBindingId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Bound entity resource name. */
    resource: string | undefined;
    /** Bound attribute resource names. */
    attributes: string[];
    /** Path-level bindings. */
    paths: DataAttributeBindingPath[];
    /** Server etag. */
    etag: string | undefined;
    /** System uid. */
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
 * A Dataplex DataAttributeBinding that associates Data Taxonomy attributes
 * with a Dataplex entity (and optional column/partition paths).
 *
 * Location, binding id, and `resource` are immutable. Description, display
 * name, labels, attributes, and paths update in place.
 *
 * ### Creating a DataAttributeBinding
 * **Example:** Bind attributes to an entity
 * ```typescript
 * const binding = yield* GCP.Dataplex.DataAttributeBinding("Pii", {
 *   resource: entity.name,
 *   attributes: [attribute.name],
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataAttributeBinding = Resource<DataAttributeBinding>(
  "GCP.Dataplex.DataAttributeBinding",
);

const resourceName = (
  project: string,
  location: string,
  dataAttributeBindingId: string,
) =>
  `projects/${project}/locations/${location}/dataAttributeBindings/${dataAttributeBindingId}`;

const toAttrs = (
  binding: dataplex.GoogleCloudDataplexV1DataAttributeBinding,
  project: string,
) => {
  const name = binding.name ?? "";
  const parsed = parseName(name, "dataAttributeBindings");
  return {
    name,
    dataAttributeBindingId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: binding.description,
    displayName: binding.displayName,
    labels: userLabels(binding.labels),
    resource: binding.resource,
    attributes: [...(binding.attributes ?? [])],
    paths: [...(binding.paths ?? [])],
    etag: binding.etag,
    uid: binding.uid,
    createTime: binding.createTime,
    updateTime: binding.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsDataAttributeBindings({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listBindings = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsDataAttributeBindings.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.dataAttributeBindings,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return listAtLocation(project, region, collect);
};

export const DataAttributeBindingProvider = () =>
  Provider.succeed(DataAttributeBinding, {
    stables: [
      "name",
      "dataAttributeBindingId",
      "project",
      "location",
      "resource",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId:
          olds?.dataAttributeBindingId ?? output?.dataAttributeBindingId,
        nextId:
          news.dataAttributeBindingId ??
          olds?.dataAttributeBindingId ??
          output?.dataAttributeBindingId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (news.resource ?? olds?.resource ?? output?.resource ?? "") !==
          (olds?.resource ?? output?.resource ?? ""),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataAttributeBindingId = yield* toPhysicalId(
        id,
        olds?.dataAttributeBindingId,
        output?.dataAttributeBindingId,
        "attrbinding",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, dataAttributeBindingId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listBindings(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataAttributeBindingId = yield* toPhysicalId(
        id,
        news.dataAttributeBindingId,
        output?.dataAttributeBindingId,
        "attrbinding",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, dataAttributeBindingId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataAttributeBindings({
            parent: parentOf(env.project, location),
            dataAttributeBindingId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              resource: news.resource,
              attributes: news.attributes,
              paths: news.paths,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const attributesChanged =
        fingerprint([...(current.attributes ?? [])].sort()) !==
        fingerprint([...(news.attributes ?? [])].sort());
      const pathsChanged =
        fingerprint(current.paths) !== fingerprint(news.paths);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        attributesChanged ||
        pathsChanged
      ) {
        const operation =
          yield* dataplex.patchProjectsLocationsDataAttributeBindings({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              attributesChanged ? "attributes" : undefined,
              pathsChanged ? "paths" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
              attributes: news.attributes,
              paths: news.paths,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsDataAttributeBindings({
          name: output.name,
          etag: output.etag,
        })
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
