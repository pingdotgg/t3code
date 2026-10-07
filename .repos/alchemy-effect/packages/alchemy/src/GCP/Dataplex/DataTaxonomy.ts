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

export type DataTaxonomyProps = {
  /**
   * Data taxonomy id (the `{dataTaxonomy}` segment of
   * `projects/{project}/locations/{location}/dataTaxonomies/{dataTaxonomy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * taxonomy.
   */
  dataTaxonomyId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the taxonomy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
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
};

export type DataTaxonomy = Resource<
  "GCP.Dataplex.DataTaxonomy",
  DataTaxonomyProps,
  {
    /** Full resource name. */
    name: string;
    /** Data taxonomy id (last path segment). */
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
    /** Number of attributes in the taxonomy. */
    attributeCount: number | undefined;
    /** Number of classes in the taxonomy. */
    classCount: number | undefined;
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
 * A Dataplex Data Taxonomy — a hierarchical grouping of DataAttributes
 * (for example PII classes).
 *
 * Changing `dataTaxonomyId` or `location` replaces the taxonomy.
 * Description, display name, and labels update in place.
 *
 * ### Creating a Data Taxonomy
 * **Example:** Generated name
 * ```typescript
 * const taxonomy = yield* GCP.Dataplex.DataTaxonomy("Pii", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const taxonomy = yield* GCP.Dataplex.DataTaxonomy("Pii", {
 *   dataTaxonomyId: "sensitive-data",
 *   displayName: "Sensitive data",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Data Taxonomy
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const taxonomy = yield* GCP.Dataplex.DataTaxonomy("Pii", {
 *   dataTaxonomyId: "sensitive-data",
 *   description: "pii classes v2",
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataTaxonomy = Resource<DataTaxonomy>("GCP.Dataplex.DataTaxonomy");

const resourceName = (
  project: string,
  location: string,
  dataTaxonomyId: string,
) =>
  `projects/${project}/locations/${location}/dataTaxonomies/${dataTaxonomyId}`;

const toAttrs = (
  taxonomy: dataplex.GoogleCloudDataplexV1DataTaxonomy,
  project: string,
) => {
  const name = taxonomy.name ?? "";
  const parsed = parseName(name, "dataTaxonomies");
  return {
    name,
    dataTaxonomyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: taxonomy.description,
    displayName: taxonomy.displayName,
    labels: userLabels(taxonomy.labels),
    attributeCount: taxonomy.attributeCount,
    classCount: taxonomy.classCount,
    etag: taxonomy.etag,
    uid: taxonomy.uid,
    createTime: taxonomy.createTime,
    updateTime: taxonomy.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsDataTaxonomies({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listTaxonomies = (project: string, region: string) => {
  const collect = (parent: string) =>
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
    );
  return listAtLocation(project, region, collect);
};

export const DataTaxonomyProvider = () =>
  Provider.succeed(DataTaxonomy, {
    stables: ["name", "dataTaxonomyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dataTaxonomyId ?? output?.dataTaxonomyId,
        nextId:
          news.dataTaxonomyId ?? olds?.dataTaxonomyId ?? output?.dataTaxonomyId,
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
      const dataTaxonomyId = yield* toPhysicalId(
        id,
        olds?.dataTaxonomyId,
        output?.dataTaxonomyId,
        "taxonomy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataTaxonomyId);
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
        const items = yield* listTaxonomies(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataTaxonomyId = yield* toPhysicalId(
        id,
        news.dataTaxonomyId,
        output?.dataTaxonomyId,
        "taxonomy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, dataTaxonomyId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsDataTaxonomies({
            parent: parentOf(env.project, location),
            dataTaxonomyId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
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

      if (labelsChanged || descriptionChanged || displayNameChanged) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsDataTaxonomies({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
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
        .deleteProjectsLocationsDataTaxonomies({
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
