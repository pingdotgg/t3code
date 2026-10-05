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
  expandParent,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ResourceAccessSpec = {
  /** Principals granted reader on the resource (`user:{email}`, …). */
  readers?: string[];
  /** Principals granted writer on the resource. */
  writers?: string[];
  /** Principals granted owner on the resource. */
  owners?: string[];
};

export type DataAccessSpec = {
  /** Principals granted reader on data stored in the resource. */
  readers?: string[];
};

export type DataTaxonomiesAttributeProps = {
  /**
   * Parent Data Taxonomy. Full name
   * `projects/{project}/locations/{location}/dataTaxonomies/{dataTaxonomy}`
   * or the taxonomy id (combined with `location`). Immutable — changing
   * it replaces the attribute.
   */
  dataTaxonomy: string;
  /**
   * Data attribute id (the `{dataAttribute}` segment of
   * `.../dataTaxonomies/{dataTaxonomy}/attributes/{dataAttribute}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * attribute.
   */
  dataAttributeId?: string;
  /**
   * Region used when `dataTaxonomy` is a bare id. Immutable — changing
   * it replaces the attribute.
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
   * Parent DataAttribute id in the same taxonomy. Maximum hierarchy
   * depth is 4.
   */
  parentId?: string;
  /**
   * Access control applied to the resource (bucket, dataset, table).
   */
  resourceAccessSpec?: ResourceAccessSpec;
  /**
   * Access control applied to data stored in the resource.
   */
  dataAccessSpec?: DataAccessSpec;
};

export type DataTaxonomiesAttribute = Resource<
  "GCP.Dataplex.DataTaxonomiesAttribute",
  DataTaxonomiesAttributeProps,
  {
    /** Full resource name. */
    name: string;
    /** Data attribute id (last path segment). */
    dataAttributeId: string;
    /** Parent taxonomy resource name. */
    dataTaxonomy: string;
    /** Parent taxonomy id. */
    dataTaxonomyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Parent attribute id, if nested. */
    parentId: string | undefined;
    /** Child attribute count. */
    attributeCount: number | undefined;
    /** Resource access spec. */
    resourceAccessSpec: ResourceAccessSpec | undefined;
    /** Data access spec. */
    dataAccessSpec: DataAccessSpec | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** System-generated uid. */
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
 * A Dataplex Data Attribute in a Data Taxonomy (for example `PII`).
 *
 * Changing `dataAttributeId`, `dataTaxonomy`, or `location` replaces
 * the attribute. Description, display name, labels, parent, and access
 * specs update in place.
 *
 * ### Creating a Data Attribute
 * **Example:** Attribute under a taxonomy
 * ```typescript
 * const attr = yield* GCP.Dataplex.DataTaxonomiesAttribute("Pii", {
 *   dataTaxonomy: taxonomy.name,
 *   displayName: "PII",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Data Attribute
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const attr = yield* GCP.Dataplex.DataTaxonomiesAttribute("Pii", {
 *   dataTaxonomy: taxonomy.name,
 *   description: "personally identifiable",
 *   labels: { env: "prod", class: "restricted" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataTaxonomiesAttribute = Resource<DataTaxonomiesAttribute>(
  "GCP.Dataplex.DataTaxonomiesAttribute",
);

const resolveParent = (
  project: string,
  dataTaxonomy: string,
  location: string | undefined,
  defaultLocation: string,
) => {
  const parent = expandParent(
    dataTaxonomy,
    project,
    normalizeLocation(location, defaultLocation),
    "dataTaxonomies",
  );
  const parsed = parseName(`${parent}/attributes/_`, "attributes");
  return {
    parent: parsed.parent,
    location: parsed.location,
    project: parsed.project || project,
    dataTaxonomyId: lastSegment(parsed.parent),
  };
};

const resourceName = (parent: string, dataAttributeId: string) =>
  `${parent}/attributes/${dataAttributeId}`;

const toAttrs = (
  attribute: dataplex.GoogleCloudDataplexV1DataAttribute,
  project: string,
) => {
  const name = attribute.name ?? "";
  const parsed = parseName(name, "attributes");
  const taxonomy = parseName(parsed.parent, "dataTaxonomies");
  return {
    name,
    dataAttributeId: parsed.id,
    dataTaxonomy: parsed.parent,
    dataTaxonomyId: taxonomy.id,
    project: parsed.project || project,
    location: parsed.location,
    description: attribute.description,
    displayName: attribute.displayName,
    labels: userLabels(attribute.labels),
    parentId: attribute.parentId,
    attributeCount: attribute.attributeCount,
    resourceAccessSpec: attribute.resourceAccessSpec,
    dataAccessSpec: attribute.dataAccessSpec,
    etag: attribute.etag,
    uid: attribute.uid,
    createTime: attribute.createTime,
    updateTime: attribute.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(
    dataplex.getProjectsLocationsDataTaxonomiesAttributes({ name }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAttributesUnder = (parent: string, project: string) =>
  collectPages(
    dataplex.listProjectsLocationsDataTaxonomiesAttributes.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.dataAttributes,
  ).pipe(
    Effect.map((items) =>
      items
        .filter((item) => hasAlchemyLabelMap(item.labels))
        .map((item) => toAttrs(item, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const DataTaxonomiesAttributeProvider = () =>
  Provider.succeed(DataTaxonomiesAttribute, {
    stables: [
      "name",
      "dataAttributeId",
      "dataTaxonomy",
      "dataTaxonomyId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dataAttributeId ?? output?.dataAttributeId,
        nextId:
          news.dataAttributeId ??
          olds?.dataAttributeId ??
          output?.dataAttributeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.dataTaxonomy ?? output?.dataTaxonomy,
        nextParent:
          news.dataTaxonomy ?? olds?.dataTaxonomy ?? output?.dataTaxonomy,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        olds?.dataTaxonomy ?? output?.dataTaxonomy ?? "",
        olds?.location ?? output?.location,
        env.region,
      );
      const dataAttributeId = yield* toPhysicalId(
        id,
        olds?.dataAttributeId,
        output?.dataAttributeId,
        "attribute",
      );
      const name =
        output?.name ?? resourceName(resolved.parent, dataAttributeId);
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
        const taxonomies = yield* listAtLocation(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              dataplex.listProjectsLocationsDataTaxonomies.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.dataTaxonomies,
            ).pipe(
              Effect.map((items) =>
                items.filter((item) => hasAlchemyLabelMap(item.labels)),
              ),
            ),
        );
        const nested = yield* Effect.forEach(
          taxonomies,
          (taxonomy) =>
            taxonomy.name
              ? listAttributesUnder(taxonomy.name, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return nested.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        news.dataTaxonomy,
        news.location ?? output?.location,
        env.region,
      );
      const dataAttributeId = yield* toPhysicalId(
        id,
        news.dataAttributeId,
        output?.dataAttributeId,
        "attribute",
      );
      const name = resourceName(resolved.parent, dataAttributeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsDataTaxonomiesAttributes({
            parent: resolved.parent,
            dataAttributeId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              parentId: news.parentId,
              resourceAccessSpec: news.resourceAccessSpec,
              dataAccessSpec: news.dataAccessSpec,
            },
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
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
      const parentChanged =
        news.parentId !== undefined &&
        (current.parentId ?? "") !== news.parentId;
      const resourceAccessChanged =
        news.resourceAccessSpec !== undefined &&
        fingerprint(news.resourceAccessSpec) !==
          fingerprint(current.resourceAccessSpec);
      const dataAccessChanged =
        news.dataAccessSpec !== undefined &&
        fingerprint(news.dataAccessSpec) !==
          fingerprint(current.dataAccessSpec);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        parentChanged ||
        resourceAccessChanged ||
        dataAccessChanged
      ) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsDataTaxonomiesAttributes({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              parentChanged ? "parentId" : undefined,
              resourceAccessChanged ? "resourceAccessSpec" : undefined,
              dataAccessChanged ? "dataAccessSpec" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
              parentId: news.parentId ?? current.parentId,
              resourceAccessSpec:
                news.resourceAccessSpec ?? current.resourceAccessSpec,
              dataAccessSpec: news.dataAccessSpec ?? current.dataAccessSpec,
            },
          }),
        );
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
        .deleteProjectsLocationsDataTaxonomiesAttributes({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "TooManyRequests",
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
